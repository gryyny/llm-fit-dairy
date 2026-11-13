import {
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import type { z } from "zod";
import { CurrentDiary, DiaryGuard, type DiaryContext } from "../access/guards.js";
import { readCatalogueRecord, searchCatalogue } from "../catalogue/search.js";
import { DB, type Db } from "../db/client.js";
import { foodLinks } from "../db/schema.js";
import { invalidInput, notFound } from "../errors.js";
import { cursorBinding } from "../paging.js";
import { checkReferences } from "./records.js";
import * as s from "./schemas.js";
import { WriteService } from "./writes.js";

const orderedPair = (a: number, b: number) => {
  if (a === b) throw invalidInput("A record cannot be linked to itself");
  return a < b ? { recordA: a, recordB: b } : { recordA: b, recordB: a };
};

/** search_catalogue, read_catalogue_record and set_food_link (CH-1). */
@Controller("api/v1/profiles/:profileId")
@UseGuards(DiaryGuard)
export class CatalogueController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WriteService) private readonly writes: WriteService,
  ) {}

  @Get("catalogue")
  search(
    @CurrentDiary() c: DiaryContext,
    @Query({ schema: s.catalogueQuery }) query: z.infer<typeof s.catalogueQuery>,
  ) {
    const accountId = c.accountId ?? "";
    const q = {
      ...(query.q === undefined ? { gtin: query.gtin ?? "" } : { q: query.q }),
      source: query.source,
      data_type: query.data_type,
      view: query.view,
    };
    return searchCatalogue(
      this.db,
      accountId,
      q,
      cursorBinding(accountId, ["catalogue", q]),
      query.limit,
      query.cursor,
    );
  }

  @Get("catalogue/records/:recordId")
  async read(
    @CurrentDiary() c: DiaryContext,
    @Param("recordId", { schema: s.recordIdParam }) recordId: number,
  ) {
    const found = await readCatalogueRecord(this.db, c.accountId ?? "", recordId);
    if (!found) throw notFound("Catalogue record");
    return found;
  }

  /** Stores one chat-confirmed same-food assertion for this account only. */
  @Put("food-links/:recordA/:recordB")
  link(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("recordA", { schema: s.recordIdParam }) a: number,
    @Param("recordB", { schema: s.recordIdParam }) b: number,
  ) {
    const accountId = c.accountId ?? "";
    const pair = orderedPair(a, b);
    return this.writes.run(c, req, res, {}, 200, async (tx) => {
      await checkReferences(tx, accountId, { recordIds: [a, b] });
      await tx
        .insert(foodLinks)
        .values({ accountId, ...pair })
        .onConflictDoNothing();
      return { link: { record_a: pair.recordA, record_b: pair.recordB } };
    });
  }

  /** Removes only this assertion; remaining links and GTIN matches still connect records. */
  @Delete("food-links/:recordA/:recordB")
  unlink(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("recordA", { schema: s.recordIdParam }) a: number,
    @Param("recordB", { schema: s.recordIdParam }) b: number,
  ) {
    const accountId = c.accountId ?? "";
    const pair = orderedPair(a, b);
    return this.writes.run(c, req, res, {}, 200, async (tx) => {
      const removed = await tx
        .delete(foodLinks)
        .where(
          and(
            eq(foodLinks.accountId, accountId),
            eq(foodLinks.recordA, pair.recordA),
            eq(foodLinks.recordB, pair.recordB),
          ),
        )
        .returning();
      if (removed.length === 0) throw notFound("Food link");
      return { removed: { record_a: pair.recordA, record_b: pair.recordB } };
    });
  }
}
