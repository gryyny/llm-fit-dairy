import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { DB, type Db } from "../db/client.js";
import {
  accounts,
  connectionInvites,
  connectionProfiles,
  oauthGrants,
  oauthTokens,
  users,
} from "../db/schema.js";
import { linkedProfileCount, MAX_PROFILES, profileView } from "../diary/profiles.js";
import { lockFoodRegistry, pruneFoods } from "../diary/records.js";
import type { Tx } from "../diary/writes.js";
import { invalidInput, notFound } from "../errors.js";
import { sha256, UUID } from "../ids.js";
import { FIREBASE, type FirebaseVerifier } from "./firebase.js";
import { CurrentCaller, ManageGuard, type Caller } from "./guards.js";
import { CONSENT_VERSION } from "./consent.js";

const idParam = z.string().regex(UUID);
const joinCode = z.string().regex(/^fdj_[A-Za-z0-9_-]{20,100}$/);
const joinBody = z.strictObject({
  code: joinCode,
  approve: z.boolean(),
  consent: z.boolean().optional(),
});

/** A connection whose last profile left can reach nothing, so it ends. */
async function endIfEmpty(tx: Db | Tx, grantIds: string[]): Promise<void> {
  for (const grantId of grantIds) {
    if ((await linkedProfileCount(tx, grantId)) > 0) continue;
    await tx.update(oauthGrants).set({ revokedAt: new Date() }).where(eq(oauthGrants.id, grantId));
    await tx.delete(oauthTokens).where(eq(oauthTokens.grantId, grantId));
  }
}

/**
 * Website API (WB-3, AC-5): only what chat cannot do, with a signed-in person's Firebase ID token.
 * Each person sees and controls only their own profile and the connections that reach it.
 */
@Controller("api/manage")
@UseGuards(ManageGuard)
export class ManageController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(FIREBASE) private readonly firebase: FirebaseVerifier,
  ) {}

  private async profile(caller: Caller) {
    const [own] = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.ownerUserId, caller.userId));
    if (!own) throw new Error("ManageGuard creates the profile");
    return own;
  }

  @Get("me")
  async me(@CurrentCaller() caller: Caller) {
    const [user] = await this.db.select().from(users).where(eq(users.id, caller.userId));
    return {
      consent_version: CONSENT_VERSION,
      consent_required: user?.consentVersion !== CONSENT_VERSION,
      user: {
        display_name: caller.displayName,
        consent_version: user?.consentVersion ?? null,
        consent_at: user?.consentAt ?? null,
      },
      profile: profileView(await this.profile(caller)),
    };
  }

  @Post("consent")
  @HttpCode(200)
  async consent(
    @CurrentCaller() caller: Caller,
    @Body({
      schema: z.strictObject({ version: z.literal(CONSENT_VERSION), consent: z.literal(true) }),
    })
    body: { version: typeof CONSENT_VERSION; consent: true },
  ) {
    await this.db
      .update(users)
      .set({ consentVersion: body.version, consentAt: new Date() })
      .where(eq(users.id, caller.userId));
    return { consent_version: body.version };
  }

  /** OA-4: ChatGPT connections that reach this profile and can still refresh. */
  @Get("connections")
  async connections(@CurrentCaller() caller: Caller) {
    const own = await this.profile(caller);
    const usable = this.db
      .select({ grantId: oauthTokens.grantId })
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.kind, "refresh"),
          isNull(oauthTokens.usedAt),
          gt(oauthTokens.expiresAt, sql`now()`),
        ),
      );
    const rows = await this.db
      .select({ grant: oauthGrants, linkedAt: connectionProfiles.createdAt })
      .from(connectionProfiles)
      .innerJoin(oauthGrants, eq(oauthGrants.id, connectionProfiles.grantId))
      .where(
        and(
          eq(connectionProfiles.accountId, own.id),
          isNull(oauthGrants.revokedAt),
          inArray(oauthGrants.id, usable),
        ),
      )
      .orderBy(asc(connectionProfiles.createdAt));
    return {
      items: rows.map((r) => ({
        connection_id: r.grant.id,
        client: r.grant.clientId,
        connected_by_me: r.grant.userId === caller.userId,
        linked_at: r.linkedAt,
        last_used_at: r.grant.lastUsedAt,
      })),
    };
  }

  /** ID-4: removes this profile from one connection; the connection's other profiles keep working. */
  @Delete("connections/:connectionId")
  async leave(
    @CurrentCaller() caller: Caller,
    @Param("connectionId", { schema: idParam }) connectionId: string,
  ) {
    const own = await this.profile(caller);
    const removed = await this.db.transaction(async (tx) => {
      const [link] = await tx
        .delete(connectionProfiles)
        .where(
          and(
            eq(connectionProfiles.grantId, connectionId),
            eq(connectionProfiles.accountId, own.id),
          ),
        )
        .returning();
      if (link) await endIfEmpty(tx, [connectionId]);
      return link;
    });
    if (!removed) throw notFound("Connection");
    return { removed: { connection_id: connectionId } };
  }

  /** ID-4: what a join link asks, before the person decides. */
  @Get("join")
  async joinRequest(
    @CurrentCaller() caller: Caller,
    @Query("code", { schema: joinCode }) code: string,
  ) {
    const invite = await this.invite(code);
    const own = await this.profile(caller);
    const [user] = await this.db.select().from(users).where(eq(users.id, caller.userId));
    const [joined] = await this.db
      .select()
      .from(connectionProfiles)
      .where(
        and(
          eq(connectionProfiles.grantId, invite.grantId),
          eq(connectionProfiles.accountId, own.id),
        ),
      );
    return {
      join: {
        client: invite.clientId,
        requested_by: invite.requestedBy,
        expires_at: invite.expiresAt,
        already_joined: joined !== undefined,
      },
      consent_required: user?.consentVersion !== CONSENT_VERSION,
      consent_version: CONSENT_VERSION,
    };
  }

  /** Approving links this person's profile to the connection; either answer uses up the link. */
  @Post("join")
  @HttpCode(200)
  async join(
    @CurrentCaller() caller: Caller,
    @Body({ schema: joinBody }) body: z.infer<typeof joinBody>,
  ) {
    const own = await this.profile(caller);
    const [user] = await this.db.select().from(users).where(eq(users.id, caller.userId));
    const consented = user?.consentVersion === CONSENT_VERSION;
    if (body.approve && !consented && body.consent !== true) {
      throw invalidInput("Agree to storing your diary records to join");
    }
    return this.db.transaction(async (tx) => {
      const [invite] = await tx
        .delete(connectionInvites)
        .where(
          and(
            eq(connectionInvites.codeHash, sha256(body.code)),
            gt(connectionInvites.expiresAt, sql`now()`),
          ),
        )
        .returning();
      const [grant] = invite
        ? await tx
            .select()
            .from(oauthGrants)
            .where(and(eq(oauthGrants.id, invite.grantId), isNull(oauthGrants.revokedAt)))
        : [];
      if (!grant) throw notFound("Join link");
      if (!body.approve) return { joined: false };
      if (!consented) {
        await tx
          .update(users)
          .set({ consentVersion: CONSENT_VERSION, consentAt: new Date() })
          .where(eq(users.id, caller.userId));
      }
      if ((await linkedProfileCount(tx, grant.id)) >= MAX_PROFILES) {
        throw invalidInput(`A connection can reach at most ${MAX_PROFILES} profiles`);
      }
      await tx
        .insert(connectionProfiles)
        .values({ grantId: grant.id, accountId: own.id })
        .onConflictDoNothing();
      return { joined: true };
    });
  }

  /** ID-5: deletes the user and profile with every record and link, ends emptied connections, then the Firebase sign-in. */
  @Delete("me")
  @HttpCode(200)
  async deleteMe(@CurrentCaller() caller: Caller) {
    const own = await this.profile(caller);
    await this.db.transaction(async (tx) => {
      const links = await tx
        .select({ grantId: connectionProfiles.grantId })
        .from(connectionProfiles)
        .where(eq(connectionProfiles.accountId, own.id));
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`profile:${own.id}`}, 0))`,
      );
      await lockFoodRegistry(tx);
      await tx.delete(users).where(eq(users.id, caller.userId));
      await pruneFoods(tx);
      await endIfEmpty(
        tx,
        links.map((l) => l.grantId),
      );
    });
    await this.firebase.deleteUser(caller.firebaseUid);
    return { deleted: true };
  }

  private async invite(code: string) {
    const [row] = await this.db
      .select({
        grantId: connectionInvites.grantId,
        expiresAt: connectionInvites.expiresAt,
        clientId: oauthGrants.clientId,
        requestedBy: users.displayName,
      })
      .from(connectionInvites)
      .innerJoin(oauthGrants, eq(oauthGrants.id, connectionInvites.grantId))
      .innerJoin(users, eq(users.id, oauthGrants.userId))
      .where(
        and(
          eq(connectionInvites.codeHash, sha256(code)),
          gt(connectionInvites.expiresAt, sql`now()`),
          isNull(oauthGrants.revokedAt),
        ),
      );
    if (!row) throw notFound("Join link");
    return row;
  }
}
