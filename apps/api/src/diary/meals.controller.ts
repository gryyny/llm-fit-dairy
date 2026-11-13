import {
  Body,
  Controller,
  Delete,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { and, eq, max, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import type { z } from "zod";
import { CurrentDiary, DiaryGuard, type DiaryContext } from "../access/guards.js";
import { entries, meals, products, recipes, targets, weights } from "../db/schema.js";
import { invalidInput, notFound } from "../errors.js";
import { uuidv7 } from "../ids.js";
import {
  checkReferences,
  itemReferences,
  itemRow,
  versioned,
  lockFoodRegistry,
  entryRevision,
  pruneFoods,
} from "./records.js";
import { loadTarget, loadWeight } from "./saved.controller.js";
import * as s from "./schemas.js";
import { entryView, mealView, loadProduct, loadRecipe } from "./views.js";
import { retainFoods } from "./retainedFoods.js";
import { WriteService, type Tx } from "./writes.js";

async function loadMeal(tx: Tx, accountId: string, mealId: string) {
  const [meal] = await tx
    .select()
    .from(meals)
    .where(and(eq(meals.id, mealId), eq(meals.accountId, accountId)));
  if (!meal) return undefined;
  return mealView(meal, await tx.select().from(entries).where(eq(entries.mealId, meal.id)));
}

/**
 * DA-6: any change to a meal's entries advances the meal's version, so an update or delete based on
 * an older read of the meal conflicts instead of silently covering food added or changed since.
 */
async function advanceMeal(tx: Tx, mealId: string) {
  const [meal] = await tx
    .update(meals)
    .set({ version: sql`${meals.version} + 1`, updatedAt: sql`now()` })
    .where(eq(meals.id, mealId))
    .returning({ id: meals.id, version: meals.version });
  if (!meal) throw notFound("Meal");
  return meal;
}

/**
 * Locks the entry's meal row before the entry is touched. A whole-meal delete locks the meal and
 * then cascades to its entries, so every path takes locks in the same meal → entries order
 * (PostgreSQL lock-order guidance against deadlocks). Undefined when the entry or meal is gone.
 */
async function lockMealOfEntry(tx: Tx, accountId: string, entryId: string) {
  const [entry] = await tx
    .select({ mealId: entries.mealId })
    .from(entries)
    .where(and(eq(entries.id, entryId), eq(entries.accountId, accountId)));
  if (!entry) return undefined;
  const [meal] = await tx
    .select({ id: meals.id })
    .from(meals)
    .where(eq(meals.id, entry.mealId))
    .for("update");
  return meal?.id;
}

const deletable = { meals, entries, products, recipes, targets, weights } as const;

async function currentRecord(
  tx: Tx,
  accountId: string,
  type: (typeof s.recordTypes)[number],
  id: string,
) {
  switch (type) {
    case "meals":
      return loadMeal(tx, accountId, id);
    case "entries": {
      const [row] = await tx
        .select()
        .from(entries)
        .where(and(eq(entries.id, id), eq(entries.accountId, accountId)));
      return row && entryView(row);
    }
    case "products":
      return loadProduct(tx, accountId, id);
    case "recipes":
      return loadRecipe(tx, accountId, id);
    case "targets":
      return loadTarget(tx, accountId, id);
    case "weights":
      return loadWeight(tx, accountId, id);
  }
}

/** save_meal, update_meal, update_entry and delete_record (CH-1). */
@Controller("api/v1/profiles/:profileId")
@UseGuards(DiaryGuard)
export class MealsController {
  constructor(@Inject(WriteService) private readonly writes: WriteService) {}

  @Post("meals")
  createMeal(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: s.newMeal }) body: z.infer<typeof s.newMeal>,
  ) {
    const accountId = c.accountId ?? "";
    return this.writes.run(c, req, res, {}, 201, async (tx) => {
      await lockFoodRegistry(tx);
      const retained = await retainFoods(tx, c, body.entries, body.new_foods);
      const mealId = uuidv7();
      await tx.insert(meals).values({
        id: mealId,
        accountId,
        diaryDate: body.diary_date,
        label: body.label ?? null,
        note: body.note ?? null,
      });
      await tx.insert(entries).values(
        retained.entries.map((e, i) => ({
          id: uuidv7(),
          accountId,
          mealId,
          recipeId: e.recipe_id ?? null,
          foodRevisionId: e.food_revision_id,
          ...itemRow(e, i + 1),
        })),
      );
      return {
        meal: await loadMeal(tx, accountId, mealId),
        retained_foods: retained.retained_foods,
      };
    });
  }

  /** Adding food to an existing meal; a daily summary never freezes the diary. */
  @Post("meals/:mealId/entries")
  addEntries(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("mealId", { schema: s.uuid }) mealId: string,
    @Body({ schema: s.addEntries }) body: z.infer<typeof s.addEntries>,
  ) {
    const accountId = c.accountId ?? "";
    return this.writes.run(c, req, res, {}, 201, async (tx) => {
      await lockFoodRegistry(tx);
      const [meal] = await tx
        .select({ id: meals.id })
        .from(meals)
        .where(and(eq(meals.id, mealId), eq(meals.accountId, accountId)))
        .for("update");
      if (!meal) throw notFound("Meal");
      const retained = await retainFoods(tx, c, body.entries, body.new_foods);
      const [last] = await tx
        .select({ position: max(entries.position) })
        .from(entries)
        .where(eq(entries.mealId, mealId));
      const start = last?.position ?? 0;
      const created = await tx
        .insert(entries)
        .values(
          retained.entries.map((e, i) => ({
            id: uuidv7(),
            accountId,
            mealId,
            recipeId: e.recipe_id ?? null,
            foodRevisionId: e.food_revision_id,
            ...itemRow(e, start + i + 1),
          })),
        )
        .returning({ id: entries.id });
      await advanceMeal(tx, mealId);
      return {
        meal: await loadMeal(tx, accountId, mealId),
        created_entry_ids: created.map((e) => e.id),
        retained_foods: retained.retained_foods,
      };
    });
  }

  @Patch("meals/:mealId")
  updateMeal(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("mealId", { schema: s.uuid }) mealId: string,
    @Query({ schema: s.versionQuery }) query: z.infer<typeof s.versionQuery>,
    @Body({ schema: s.mealPatch }) body: z.infer<typeof s.mealPatch>,
  ) {
    const accountId = c.accountId ?? "";
    return this.writes.run(c, req, res, query, 200, async (tx) => {
      await lockFoodRegistry(tx);
      const [updated] = await tx
        .update(meals)
        .set({
          ...(body.diary_date === undefined ? {} : { diaryDate: body.diary_date }),
          ...(body.label === undefined ? {} : { label: body.label }),
          ...(body.note === undefined ? {} : { note: body.note }),
          version: sql`${meals.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(meals.id, mealId),
            eq(meals.accountId, accountId),
            eq(meals.version, query.version),
          ),
        )
        .returning({ id: meals.id });
      await versioned(updated, "Meal", () => loadMeal(tx, accountId, mealId));
      return { meal: await loadMeal(tx, accountId, mealId) };
    });
  }

  /**
   * Changes only the given fields; nutrients are merged key by key, so a calorie-only correction
   * keeps the other values. The merged entry must still satisfy the source rule (DA-5).
   */
  @Patch("entries/:entryId")
  updateEntry(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("entryId", { schema: s.uuid }) entryId: string,
    @Query({ schema: s.versionQuery }) query: z.infer<typeof s.versionQuery>,
    @Body({ schema: s.entryPatch }) body: z.infer<typeof s.entryPatch>,
  ) {
    const accountId = c.accountId ?? "";
    return this.writes.run(c, req, res, query, 200, async (tx) => {
      await lockFoodRegistry(tx);
      if (!(await lockMealOfEntry(tx, accountId, entryId))) throw notFound("Entry");
      const [current] = await tx
        .select()
        .from(entries)
        .where(and(eq(entries.id, entryId), eq(entries.accountId, accountId)))
        .for("update");
      if (!current) throw notFound("Entry");
      const view = entryView(current);
      if (current.version !== query.version)
        await versioned(undefined, "Entry", () => Promise.resolve(view));
      const merged = s.entry.safeParse({
        name: view.name,
        quantity: view.quantity,
        unit: view.unit,
        source: view.source,
        partial_nutrients: view.partial_nutrients,
        note: view.note,
        catalogue_record_id: view.catalogue_record_id,
        product_id: view.product_id,
        recipe_id: view.recipe_id,
        label: view.label,
        diary_only_reason: body.product_id || body.recipe_id ? null : view.diary_only_reason,
        ...body,
        nutrients: Object.fromEntries(
          Object.entries({ ...view.nutrients, ...body.nutrients }).filter(([, v]) => v !== null),
        ),
      });
      if (!merged.success)
        throw invalidInput(
          merged.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      await checkReferences(tx, accountId, itemReferences([merged.data]));
      const [updated] = await tx
        .update(entries)
        .set({
          ...itemRow(merged.data, current.position),
          recipeId: merged.data.recipe_id ?? null,
          foodRevisionId:
            body.product_id !== undefined || body.recipe_id !== undefined
              ? await entryRevision(tx, accountId, merged.data)
              : current.foodRevisionId,
          version: current.version + 1,
          updatedAt: sql`now()`,
        })
        .where(eq(entries.id, entryId))
        .returning();
      if (!updated) throw notFound("Entry");
      return { entry: entryView(updated), meal: await advanceMeal(tx, updated.mealId) };
    });
  }

  /** DA-7: hard delete; a meal takes its entries; products and recipes leave logged entries intact. */
  @Delete(":recordType/:recordId")
  delete(
    @CurrentDiary() c: DiaryContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("recordType", { schema: s.recordType }) recordType: (typeof s.recordTypes)[number],
    @Param("recordId", { schema: s.uuid }) recordId: string,
    @Query({ schema: s.versionQuery }) query: z.infer<typeof s.versionQuery>,
  ) {
    const accountId = c.accountId ?? "";
    const table = deletable[recordType];
    return this.writes.run(c, req, res, query, 200, async (tx) => {
      await lockFoodRegistry(tx);
      const mealId =
        recordType === "entries" ? await lockMealOfEntry(tx, accountId, recordId) : undefined;
      const [deleted] = await tx
        .delete(table)
        .where(
          and(
            eq(table.id, recordId),
            eq(table.accountId, accountId),
            eq(table.version, query.version),
          ),
        )
        .returning({ id: table.id });
      await versioned(deleted, "Record", () => currentRecord(tx, accountId, recordType, recordId));
      await pruneFoods(tx);
      return {
        deleted: { record_type: recordType, id: recordId },
        ...(mealId ? { meal: await advanceMeal(tx, mealId) } : {}),
      };
    });
  }
}
