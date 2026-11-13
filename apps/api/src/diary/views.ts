import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Tx } from "./writes.js";
import {
  entries,
  foodDefinitions,
  foodRevisions,
  meals,
  products,
  recipeIngredients,
  recipes,
  targets,
  weights,
} from "../db/schema.js";

type Entry = typeof entries.$inferSelect;
type Ingredient = typeof recipeIngredients.$inferSelect;

const label = (i: Entry | Ingredient) =>
  i.labelBasisAmount === null || i.labelBasisUnit === null
    ? null
    : {
        basis_amount: i.labelBasisAmount,
        basis_unit: i.labelBasisUnit,
        nutrients: i.labelNutrients ?? {},
      };

const item = (i: Entry | Ingredient) => ({
  id: i.id,
  position: i.position,

  quantity: i.quantity,
  unit: i.unit,
  nutrients: i.nutrients,
  partial_nutrients: i.partialNutrients,
  source: i.source,

  catalogue_record_id: i.catalogueRecordId,

  label: label(i),
});

export const entryView = (e: Entry) => ({
  ...item(e),
  name: e.name,
  note: e.note,
  product_id: e.productId,
  food_revision_id: e.foodRevisionId,
  diary_only_reason: e.diaryOnlyReason,
  meal_id: e.mealId,
  recipe_id: e.recipeId,
  version: e.version,
  created_at: e.createdAt,
  updated_at: e.updatedAt,
});

export const mealView = (m: typeof meals.$inferSelect, mealEntries: Entry[]) => ({
  id: m.id,
  diary_date: m.diaryDate,
  label: m.label,
  note: m.note,
  version: m.version,
  created_at: m.createdAt,
  updated_at: m.updatedAt,
  entries: mealEntries
    .filter((e) => e.mealId === m.id)
    .sort((a, b) => a.position - b.position)
    .map(entryView),
});

export function productView(
  p: typeof products.$inferSelect,
  revision: typeof foodRevisions.$inferSelect,
  identityKey: string | null,
) {
  const facts = revision.content;
  if (facts.kind !== "product") throw new Error("product revision kind mismatch");
  return {
    id: p.id,
    food_id: p.foodId,
    revision_id: p.revisionId,
    name: p.name,
    brand: facts.brand,
    barcode: facts.barcode,
    gtin_key: facts.gtinKey,
    food_kind: facts.foodKind,
    variant: facts.variant,
    recognition_description: p.recognitionDescription,
    preparation: facts.preparation,
    provenance: facts.provenance,
    identity_key: identityKey,
    basis_amount: facts.basisAmount,
    basis_unit: facts.basisUnit,
    nutrients: facts.nutrients,
    preferred_record_ids: p.preferredRecordIds,
    note: p.note,
    version: p.version,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

export async function loadProduct(db: Db | Tx, accountId: string, id: string) {
  const [row] = await db
    .select()
    .from(products)
    .innerJoin(foodRevisions, eq(foodRevisions.id, products.revisionId))
    .innerJoin(foodDefinitions, eq(foodDefinitions.id, products.foodId))
    .where(and(eq(products.id, id), eq(products.accountId, accountId)));
  return row && productView(row.products, row.food_revisions, row.food_definitions.identityKey);
}

export async function loadRecipe(db: Db | Tx, accountId: string, id: string) {
  const [row] = await db
    .select()
    .from(recipes)
    .innerJoin(foodRevisions, eq(foodRevisions.id, recipes.revisionId))
    .where(and(eq(recipes.id, id), eq(recipes.accountId, accountId)));
  if (!row) return undefined;
  const r = row.recipes;
  const facts = row.food_revisions.content;
  if (facts.kind !== "recipe") throw new Error("recipe revision kind mismatch");
  const ingredients = await db
    .select()
    .from(recipeIngredients)
    .where(eq(recipeIngredients.recipeRevisionId, r.revisionId))
    .orderBy(recipeIngredients.position);
  const revisionIds = ingredients.flatMap((i) =>
    i.productRevisionId ? [i.productRevisionId] : [],
  );
  const links = revisionIds.length
    ? await db
        .select()
        .from(products)
        .where(and(eq(products.accountId, accountId), inArray(products.revisionId, revisionIds)))
    : [];
  return {
    id: r.id,
    food_id: r.foodId,
    revision_id: r.revisionId,
    name: r.name,
    recognition_description: r.recognitionDescription,
    yield_amount: facts.yieldAmount,
    yield_unit: facts.yieldUnit,
    servings: facts.servings,
    nutrients: facts.nutrients,
    partial_nutrients: facts.partialNutrients,
    note: r.note,
    version: r.version,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    ingredients: ingredients.map((i) => ({
      ...item(i),
      name: r.ingredientDetails[i.id]?.name ?? "",
      note: r.ingredientDetails[i.id]?.note ?? "",
      product_id: links.find((p) => p.revisionId === i.productRevisionId)?.id ?? null,
      food_revision_id: i.productRevisionId,
    })),
  };
}

export const targetView = (t: typeof targets.$inferSelect) => ({
  id: t.id,
  rationale: t.rationale,
  inputs: t.inputs,
  kind: t.kind,
  effective_from: t.effectiveFrom,
  values: t.values,
  note: t.note,
  version: t.version,
  created_at: t.createdAt,
  updated_at: t.updatedAt,
});

export const weightView = (w: typeof weights.$inferSelect) => ({
  id: w.id,
  date: w.measuredOn,
  value: w.value,
  unit: w.unit,
  note: w.note,
  version: w.version,
  created_at: w.createdAt,
  updated_at: w.updatedAt,
});
