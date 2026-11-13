import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { and, between, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { CurrentDiary, DiaryGuard, type DiaryContext } from "../access/guards.js";
import { DB, type Db } from "../db/client.js";
import { dayTargets, entries, meals, targets, weights } from "../db/schema.js";
import { cursorBinding, decodeCursor, encodeCursor, positions } from "../paging.js";
import { contains, dayTargetView } from "./records.js";
import * as s from "./schemas.js";
import { entryView, mealView, loadProduct, loadRecipe, weightView } from "./views.js";

function days(from: string, to: string): string[] {
  const result: string[] = [];
  for (
    let d = Date.parse(`${from}T00:00:00Z`);
    d <= Date.parse(`${to}T00:00:00Z`);
    d += 86_400_000
  ) {
    result.push(new Date(d).toISOString().slice(0, 10));
  }
  return result;
}

/** read_diary and search_diary (CH-1). */
@Controller("api/v1/profiles/:profileId")
@UseGuards(DiaryGuard)
export class ReadController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Meals with entries, weights, the day's selected kind (normal by default) and its effective target. */
  @Get("diary")
  async readDiary(
    @CurrentDiary() c: DiaryContext,
    @Query({ schema: s.diaryRange }) range: z.infer<typeof s.diaryRange>,
  ) {
    const accountId = c.accountId ?? "";
    const [mealRows, weightRows, selections, variants] = await Promise.all([
      this.db
        .select()
        .from(meals)
        .where(and(eq(meals.accountId, accountId), between(meals.diaryDate, range.from, range.to)))
        .orderBy(meals.diaryDate, meals.createdAt, meals.id),
      this.db
        .select()
        .from(weights)
        .where(
          and(eq(weights.accountId, accountId), between(weights.measuredOn, range.from, range.to)),
        )
        .orderBy(weights.measuredOn, weights.id),
      this.db
        .select()
        .from(dayTargets)
        .where(
          and(
            eq(dayTargets.accountId, accountId),
            between(dayTargets.diaryDate, range.from, range.to),
          ),
        ),
      this.db.select().from(targets).where(eq(targets.accountId, accountId)),
    ]);
    const entryRows = mealRows.length
      ? await this.db
          .select()
          .from(entries)
          .where(
            inArray(
              entries.mealId,
              mealRows.map((m) => m.id),
            ),
          )
      : [];
    return {
      profile_id: accountId,
      from: range.from,
      to: range.to,
      days: days(range.from, range.to).map((date) => {
        const selected = selections.find((d) => d.diaryDate === date);
        return {
          ...dayTargetView(date, selected, variants),
          meals: mealRows.filter((m) => m.diaryDate === date).map((m) => mealView(m, entryRows)),
          weights: weightRows.filter((w) => w.measuredOn === date).map(weightView),
        };
      }),
    };
  }

  /**
   * Text search over entries, usual products and recipes, newest first. Each item names its type;
   * entries carry their meal's date and label.
   */
  @Get("search")
  async searchDiary(
    @CurrentDiary() c: DiaryContext,
    @Query({ schema: s.searchQuery }) query: z.infer<typeof s.searchQuery>,
  ) {
    const accountId = c.accountId ?? "";
    const binding = cursorBinding(accountId, ["search", query.q]);
    const before = query.cursor ? decodeCursor(binding, query.cursor, positions.id)[0] : null;
    const pattern = contains(query.q);
    const beforeSql = before ? sql`AND id < ${before}::uuid` : sql``;
    const hits = await this.db.execute<{ type: "entry" | "product" | "recipe"; id: string }>(sql`
      SELECT * FROM (
        SELECT 'entry' AS type, id FROM entries
          WHERE account_id = ${accountId} AND (name ILIKE ${pattern} OR note ILIKE ${pattern})
        UNION ALL
        SELECT 'product', p.id FROM products p JOIN food_revisions v ON v.id=p.revision_id
          WHERE account_id = ${accountId} AND (name ILIKE ${pattern} OR v.content->>'brand' ILIKE ${pattern} OR note ILIKE ${pattern})
        UNION ALL
        SELECT 'recipe', id FROM recipes
          WHERE account_id = ${accountId} AND (name ILIKE ${pattern} OR note ILIKE ${pattern})
      ) hits WHERE true ${beforeSql}
      ORDER BY id DESC LIMIT ${query.limit + 1}`);
    const page = hits.rows.slice(0, query.limit);
    const ids = (type: string) => page.filter((h) => h.type === type).map((h) => h.id);
    const [entryRows, productRows, recipeRows] = await Promise.all([
      ids("entry").length
        ? this.db
            .select({ entry: entries, diaryDate: meals.diaryDate, mealLabel: meals.label })
            .from(entries)
            .innerJoin(meals, eq(meals.id, entries.mealId))
            .where(inArray(entries.id, ids("entry")))
        : [],
      Promise.all(ids("product").map((id) => loadProduct(this.db, accountId, id))),
      Promise.all(ids("recipe").map((id) => loadRecipe(this.db, accountId, id))),
    ]);
    const items = page.map((hit) => {
      if (hit.type === "entry") {
        const row = entryRows.find((e) => e.entry.id === hit.id);
        return {
          type: hit.type,
          entry: row && {
            ...entryView(row.entry),
            diary_date: row.diaryDate,
            meal_label: row.mealLabel,
          },
        };
      }
      if (hit.type === "product") {
        const row = productRows.find((p) => p?.id === hit.id);
        return { type: hit.type, product: row };
      }
      const row = recipeRows.find((r) => r?.id === hit.id);
      return { type: hit.type, recipe: row };
    });
    const last = page.at(-1);
    const more = hits.rows.length > query.limit && last !== undefined;
    return { items, next_cursor: more ? encodeCursor(binding, [last.id]) : null, complete: !more };
  }
}
