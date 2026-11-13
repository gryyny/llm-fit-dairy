import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { and, asc, desc, eq, gt, gte, ilike, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { Request, Response } from "express";
import type { z } from "zod";
import { CurrentDiary, DiaryGuard, type DiaryContext } from "../access/guards.js";
import { DB, type Db } from "../db/client.js";
import {
  dayTargets,
  products,
  foodDefinitions,
  foodRevisions,
  recipes,
  targets,
  weights,
} from "../db/schema.js";
import { ISSUER } from "../access/tokens.js";
import { validateGoalInputs } from "./body.js";
import { uuidv7 } from "../ids.js";
import { notFound } from "../errors.js";
import { cursorBinding, decodeCursor, encodeCursor, positions, type Page } from "../paging.js";
import {
  contains,
  dayTargetView,
  prepareRecipe,
  pruneFoods,
  linkSharedFood,
  prepareProduct,
  retainProduct,
  uniqueOr,
  versioned,
} from "./records.js";
import * as s from "./schemas.js";
import { listFoods } from "./foods.js";
import { loadProduct, loadRecipe, productView, targetView, weightView } from "./views.js";
import { WriteService, type Tx } from "./writes.js";

export async function loadTarget(db: Db | Tx, accountId: string, id: string) {
  const [row] = await db
    .select()
    .from(targets)
    .where(and(eq(targets.id, id), eq(targets.accountId, accountId)));
  return row && targetView(row);
}

export async function loadWeight(db: Db | Tx, accountId: string, id: string) {
  const [row] = await db
    .select()
    .from(weights)
    .where(and(eq(weights.id, id), eq(weights.accountId, accountId)));
  return row && weightView(row);
}

const targetRow = (t: z.infer<typeof s.target>) => ({
  rationale: t.rationale ?? null,
  inputs: t.inputs ?? null,
  kind: t.kind,
  effectiveFrom: t.effective_from,
  values: t.values,
  note: t.note ?? null,
});

const weightRow = (w: z.infer<typeof s.weight>) => ({
  measuredOn: w.date,
  value: w.value,
  unit: w.unit,
  note: w.note ?? null,
});

const duplicateTarget =
  "A target of this kind already starts on that date; update that target instead";

/** Keyset page: `limit + 1` rows tell whether anything was cut off. */
function page<T>(
  rows: T[],
  limit: number,
  binding: string,
  key: (row: T) => (string | number)[],
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const more = rows.length > limit && last !== undefined;
  return { items, next_cursor: more ? encodeCursor(binding, key(last)) : null, complete: !more };
}

/** save_product, save_recipe, save_target, save_weight, select_day_target and list_saved (CH-1). */
@Controller("api/v1/profiles/:profileId")
@UseGuards(DiaryGuard)
export class SavedController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WriteService) private readonly writes: WriteService,
    @Inject(ISSUER) private readonly issuer: string,
  ) {}

  @Get("products/:id")
  async product(@CurrentDiary() c: DiaryContext, @Param("id", { schema: s.uuid }) id: string) {
    const product = await loadProduct(this.db, c.accountId ?? "", id);
    if (!product) throw notFound("Product");
    return { product };
  }

  @Get("recipes/:id")
  async recipe(@CurrentDiary() c: DiaryContext, @Param("id", { schema: s.uuid }) id: string) {
    const recipe = await loadRecipe(this.db, c.accountId ?? "", id);
    if (!recipe) throw notFound("Recipe");
    return { recipe };
  }

  @Post("products")
  createProduct(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: s.product }) body: z.infer<typeof s.product>,
  ) {
    const accountId = c.accountId ?? "";
    return this.writes.run(c, req, res, {}, 201, async (tx) => {
      const { product, outcome } = await retainProduct(tx, accountId, body);
      return { product, outcome };
    });
  }

  /** Later edits never rewrite logged meals: entries keep their own value snapshots. */
  @Put("products/:id")
  updateProduct(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("id", { schema: s.uuid }) id: string,
    @Query({ schema: s.versionQuery }) query: z.infer<typeof s.versionQuery>,
    @Body({ schema: s.productUpdate }) body: z.infer<typeof s.productUpdate>,
  ) {
    const accountId = c.accountId ?? "";
    return this.writes.run(c, req, res, query, 200, async (tx) => {
      const current = await loadProduct(tx, accountId, id);
      await versioned(current?.version === query.version ? current : undefined, "Product", () =>
        Promise.resolve(current),
      );
      const { values } = await prepareProduct(tx, accountId, body, { updateId: id });
      if (!values) throw new Error("product update values missing");
      const [updated] = await tx
        .update(products)
        .set({ ...values, version: sql`${products.version} + 1`, updatedAt: sql`now()` })
        .where(
          and(
            eq(products.id, id),
            eq(products.accountId, accountId),
            eq(products.version, query.version),
          ),
        )
        .returning({ id: products.id });
      await versioned(updated, "Product", () => loadProduct(tx, accountId, id));
      await pruneFoods(tx);
      return { product: await loadProduct(tx, accountId, id) };
    });
  }

  @Post("recipes")
  createRecipe(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: s.recipe }) body: z.infer<typeof s.recipe>,
  ) {
    const accountId = c.accountId ?? "";
    return this.writes.run(c, req, res, {}, 201, async (tx) => {
      const values = await prepareRecipe(tx, accountId, body);
      const id = uuidv7();
      await tx.insert(recipes).values({ id, accountId, ...values });
      return { recipe: await loadRecipe(tx, accountId, id) };
    });
  }

  /** DA-10: saving a recipe replaces its whole ingredient list in one write. */
  @Put("recipes/:id")
  updateRecipe(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("id", { schema: s.uuid }) id: string,
    @Query({ schema: s.versionQuery }) query: z.infer<typeof s.versionQuery>,
    @Body({ schema: s.recipe }) body: z.infer<typeof s.recipe>,
  ) {
    const accountId = c.accountId ?? "";
    return this.writes.run(c, req, res, query, 200, async (tx) => {
      const current = await loadRecipe(tx, accountId, id);
      await versioned(current?.version === query.version ? current : undefined, "Recipe", () =>
        Promise.resolve(current),
      );
      const values = await prepareRecipe(tx, accountId, body, id);
      const [updated] = await tx
        .update(recipes)
        .set({ ...values, version: sql`${recipes.version} + 1`, updatedAt: sql`now()` })
        .where(
          and(
            eq(recipes.id, id),
            eq(recipes.accountId, accountId),
            eq(recipes.version, query.version),
          ),
        )
        .returning({ id: recipes.id });
      await versioned(updated, "Recipe", () => loadRecipe(tx, accountId, id));
      return { recipe: await loadRecipe(tx, accountId, id) };
    });
  }

  @Post("foods/link")
  linkFood(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: s.linkFood }) body: z.infer<typeof s.linkFood>,
  ) {
    return this.writes.run(c, req, res, {}, 201, (tx) => linkSharedFood(tx, c, body));
  }

  /** Targets are saved only when the person agreed to them (skill rule CH-4). */
  @Post("targets")
  createTarget(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: s.target }) body: z.infer<typeof s.target>,
  ) {
    const accountId = c.accountId ?? "";
    return this.writes.run(c, req, res, {}, 201, async (tx) => {
      await validateGoalInputs(tx, accountId, body, this.issuer);
      const id = uuidv7();
      await uniqueOr(
        duplicateTarget,
        tx.insert(targets).values({ id, accountId, ...targetRow(body) }),
      );
      return { target: await loadTarget(tx, accountId, id) };
    });
  }

  @Put("targets/:id")
  updateTarget(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("id", { schema: s.uuid }) id: string,
    @Query({ schema: s.versionQuery }) query: z.infer<typeof s.versionQuery>,
    @Body({ schema: s.target }) body: z.infer<typeof s.target>,
  ) {
    const accountId = c.accountId ?? "";
    return this.writes.run(c, req, res, query, 200, async (tx) => {
      await validateGoalInputs(tx, accountId, body, this.issuer);
      const [updated] = await uniqueOr(
        duplicateTarget,
        tx
          .update(targets)
          .set({ ...targetRow(body), version: sql`${targets.version} + 1`, updatedAt: sql`now()` })
          .where(
            and(
              eq(targets.id, id),
              eq(targets.accountId, accountId),
              eq(targets.version, query.version),
            ),
          )
          .returning({ id: targets.id }),
      );
      await versioned(updated, "Target", () => loadTarget(tx, accountId, id));
      return { target: await loadTarget(tx, accountId, id) };
    });
  }

  @Post("weights")
  createWeight(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: s.weight }) body: z.infer<typeof s.weight>,
  ) {
    const accountId = c.accountId ?? "";
    return this.writes.run(c, req, res, {}, 201, async (tx) => {
      const id = uuidv7();
      await tx.insert(weights).values({ id, accountId, ...weightRow(body) });
      return { weight: await loadWeight(tx, accountId, id) };
    });
  }

  @Put("weights/:id")
  updateWeight(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("id", { schema: s.uuid }) id: string,
    @Query({ schema: s.versionQuery }) query: z.infer<typeof s.versionQuery>,
    @Body({ schema: s.weight }) body: z.infer<typeof s.weight>,
  ) {
    const accountId = c.accountId ?? "";
    return this.writes.run(c, req, res, query, 200, async (tx) => {
      const [updated] = await tx
        .update(weights)
        .set({ ...weightRow(body), version: sql`${weights.version} + 1`, updatedAt: sql`now()` })
        .where(
          and(
            eq(weights.id, id),
            eq(weights.accountId, accountId),
            eq(weights.version, query.version),
          ),
        )
        .returning({ id: weights.id });
      await versioned(updated, "Weight", () => loadWeight(tx, accountId, id));
      return { weight: await loadWeight(tx, accountId, id) };
    });
  }

  /**
   * DA-8: selects the target kind for one diary day. Changing an existing selection needs the
   * `target_kind_version` read for that day (DA-6); a first selection is made without one.
   */
  @Put("days/:date/target-kind")
  selectDayTarget(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("date", { schema: s.isoDate }) date: string,
    @Query({ schema: s.optionalVersionQuery }) query: z.infer<typeof s.optionalVersionQuery>,
    @Body({ schema: s.dayTarget }) body: z.infer<typeof s.dayTarget>,
  ) {
    const accountId = c.accountId ?? "";
    return this.writes.run(c, req, res, query, 200, async (tx) => {
      const variants = await tx.select().from(targets).where(eq(targets.accountId, accountId));
      const where = and(eq(dayTargets.accountId, accountId), eq(dayTargets.diaryDate, date));
      const [stored] =
        query.version === undefined
          ? await tx
              .insert(dayTargets)
              .values({ accountId, diaryDate: date, kind: body.kind })
              .onConflictDoNothing()
              .returning()
          : await tx
              .update(dayTargets)
              .set({
                kind: body.kind,
                version: sql`${dayTargets.version} + 1`,
                updatedAt: sql`now()`,
              })
              .where(and(where, eq(dayTargets.version, query.version)))
              .returning();
      if (!stored) {
        const [current] = await tx.select().from(dayTargets).where(where);
        await versioned(undefined, "Day target selection", () =>
          Promise.resolve(dayTargetView(date, current, variants)),
        );
      }
      return { day: dayTargetView(date, stored, variants) };
    });
  }

  @Get("foods")
  foods(
    @CurrentDiary() c: DiaryContext,
    @Query({ schema: s.foodsQuery }) query: z.infer<typeof s.foodsQuery>,
  ) {
    return listFoods(this.db, c, query);
  }

  @Get("products")
  async listProducts(
    @CurrentDiary() c: DiaryContext,
    @Query({ schema: s.namedListQuery }) query: z.infer<typeof s.namedListQuery>,
  ) {
    const accountId = c.accountId ?? "";
    const binding = cursorBinding(accountId, ["products", query.q ?? null]);
    const after = query.cursor ? decodeCursor(binding, query.cursor, positions.id)[0] : null;
    const filters: (SQL | undefined)[] = [
      eq(products.accountId, accountId),
      query.q
        ? or(
            ilike(products.name, contains(query.q)),
            sql`${foodRevisions.content}->>'brand' ILIKE ${contains(query.q)}`,
            ilike(products.note, contains(query.q)),
          )
        : undefined,
      after ? gt(products.id, after) : undefined,
    ];
    const rows = await this.db
      .select()
      .from(products)
      .innerJoin(foodRevisions, eq(foodRevisions.id, products.revisionId))
      .innerJoin(foodDefinitions, eq(foodDefinitions.id, products.foodId))
      .where(and(...filters))
      .orderBy(asc(products.id))
      .limit(query.limit + 1);
    return page(
      rows.map((r) => productView(r.products, r.food_revisions, r.food_definitions.identityKey)),
      query.limit,
      binding,
      (p) => [p.id],
    );
  }

  @Get("recipes")
  async listRecipes(
    @CurrentDiary() c: DiaryContext,
    @Query({ schema: s.namedListQuery }) query: z.infer<typeof s.namedListQuery>,
  ) {
    const accountId = c.accountId ?? "";
    const binding = cursorBinding(accountId, ["recipes", query.q ?? null]);
    const after = query.cursor ? decodeCursor(binding, query.cursor, positions.id)[0] : null;
    const filters: (SQL | undefined)[] = [
      eq(recipes.accountId, accountId),
      query.q
        ? or(ilike(recipes.name, contains(query.q)), ilike(recipes.note, contains(query.q)))
        : undefined,
      after ? gt(recipes.id, after) : undefined,
    ];
    const rows = await this.db
      .select()
      .from(recipes)
      .where(and(...filters))
      .orderBy(asc(recipes.id))
      .limit(query.limit + 1);
    const items = await Promise.all(rows.map((r) => loadRecipe(this.db, accountId, r.id)));
    return page(
      items.filter((r) => r !== undefined),
      query.limit,
      binding,
      (r) => [r.id],
    );
  }

  /** Every saved variant with its effective date, newest first, including unused training variants. */
  @Get("targets")
  async listTargets(
    @CurrentDiary() c: DiaryContext,
    @Query({ schema: s.targetListQuery }) query: z.infer<typeof s.targetListQuery>,
  ) {
    const accountId = c.accountId ?? "";
    const binding = cursorBinding(accountId, [
      "targets",
      query.kind ?? null,
      query.effective_on ?? null,
    ]);
    const [afterDate, afterId] = query.cursor
      ? decodeCursor(binding, query.cursor, positions.dateId)
      : [];
    const filters: (SQL | undefined)[] = [
      eq(targets.accountId, accountId),
      query.kind ? eq(targets.kind, query.kind) : undefined,
      query.effective_on ? lte(targets.effectiveFrom, query.effective_on) : undefined,
      afterDate && afterId
        ? or(
            lt(targets.effectiveFrom, afterDate),
            and(eq(targets.effectiveFrom, afterDate), lt(targets.id, afterId)),
          )
        : undefined,
    ];
    const rows = await this.db
      .select()
      .from(targets)
      .where(and(...filters))
      .orderBy(desc(targets.effectiveFrom), desc(targets.id))
      .limit(query.limit + 1);
    return page(rows.map(targetView), query.limit, binding, (t) => [t.effective_from, t.id]);
  }

  @Get("weights")
  async listWeights(
    @CurrentDiary() c: DiaryContext,
    @Query({ schema: s.weightListQuery }) query: z.infer<typeof s.weightListQuery>,
  ) {
    const accountId = c.accountId ?? "";
    const binding = cursorBinding(accountId, ["weights", query.from ?? null, query.to ?? null]);
    const [afterDate, afterId] = query.cursor
      ? decodeCursor(binding, query.cursor, positions.dateId)
      : [];
    const filters: (SQL | undefined)[] = [
      eq(weights.accountId, accountId),
      query.from ? gte(weights.measuredOn, query.from) : undefined,
      query.to ? lte(weights.measuredOn, query.to) : undefined,
      afterDate && afterId
        ? or(
            lt(weights.measuredOn, afterDate),
            and(eq(weights.measuredOn, afterDate), lt(weights.id, afterId)),
          )
        : undefined,
    ];
    const rows = await this.db
      .select()
      .from(weights)
      .where(and(...filters))
      .orderBy(desc(weights.measuredOn), desc(weights.id))
      .limit(query.limit + 1);
    return page(rows.map(weightView), query.limit, binding, (w) => [w.date, w.id]);
  }
}
