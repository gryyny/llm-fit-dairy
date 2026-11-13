import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { accounts, bodyContexts } from "../db/schema.js";
import { ApiError, notFound } from "../errors.js";
import { requireBodyConsent } from "../access/consent.js";
import { readBody } from "./body.js";
import * as s from "./schemas.js";
import type { Request, Response } from "express";
import { CurrentDiary, DiaryGuard, type DiaryContext } from "../access/guards.js";
import { ISSUER } from "../access/tokens.js";
import { DB, type Db } from "../db/client.js";
import { createInvite, listProfiles, profileView } from "./profiles.js";
import { versioned } from "./records.js";
import { WriteService } from "./writes.js";

/** list_profiles and add_profile (MC-2): a connection reaches only profiles that joined it. */
@Controller("api/v1/profiles")
@UseGuards(DiaryGuard)
export class ProfilesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WriteService) private readonly writes: WriteService,
    @Inject(ISSUER) private readonly issuer: string,
  ) {}

  @Get()
  async list(@CurrentDiary() c: DiaryContext) {
    return { items: await listProfiles(this.db, c), next_cursor: null, complete: true };
  }

  @Get(":profileId")
  async read(@CurrentDiary() c: DiaryContext) {
    const [profile] = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, c.accountId ?? ""));
    if (!profile) throw notFound("Profile");
    return { profile: profileView(profile), body_context: await readBody(this.db, profile.id) };
  }

  @Patch(":profileId")
  rename(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query({ schema: s.versionQuery }) query: z.infer<typeof s.versionQuery>,
    @Body({ schema: s.profileName }) body: z.infer<typeof s.profileName>,
  ) {
    const id = c.accountId ?? "";
    return this.writes.run(c, req, res, query, 200, async (tx) => {
      const [updated] = await tx
        .update(accounts)
        .set({ displayName: body.name, version: query.version + 1 })
        .where(and(eq(accounts.id, id), eq(accounts.version, query.version)))
        .returning();
      const profile = await versioned(updated, "Profile", async () => {
        const [row] = await tx.select().from(accounts).where(eq(accounts.id, id));
        return row && profileView(row);
      });
      return { profile: profileView(profile) };
    });
  }

  @Patch(":profileId/body-context")
  updateBody(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("profileId", { schema: s.uuid }) _id: string,
    @Query({ schema: s.bodyVersionQuery }) query: z.infer<typeof s.bodyVersionQuery>,
    @Body({ schema: s.bodyPatch }) body: z.infer<typeof s.bodyPatch>,
  ) {
    const accountId = c.accountId ?? "";
    return this.writes.run(c, req, res, query, 200, async (tx) => {
      if (Object.values(body).some((value) => value !== null))
        await requireBodyConsent(tx, accountId, this.issuer);
      const current = await readBody(tx, accountId);
      if ((current?.version ?? 0) !== query.version)
        throw new ApiError(
          409,
          "version_conflict",
          "Body context changed; read it before retrying.",
          { body_context: current },
        );
      const { date_of_birth, ...fields } = body;
      const changes = { ...fields, dateOfBirth: date_of_birth };
      if (!current) await tx.insert(bodyContexts).values({ accountId, ...changes });
      else
        await tx
          .update(bodyContexts)
          .set({ ...changes, version: current.version + 1, updatedAt: new Date() })
          .where(
            and(eq(bodyContexts.accountId, accountId), eq(bodyContexts.version, query.version)),
          );
      return { body_context: await readBody(tx, accountId) };
    });
  }

  /** A join link for another person to add their own profile to this connection (ID-4). */
  @Post("invites")
  invite(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.writes.run(c, req, res, {}, 201, async (tx) => ({
      invite: await createInvite(tx, c.grantId ?? "", this.issuer),
    }));
  }
}
