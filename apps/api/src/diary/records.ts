import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  catalogueRecord,
  connectionProfiles,
  foodDefinitions,
  foodRevisions,
  type ProductFacts,
  type RecipeFacts,
  recipeIngredients,
  products,
  recipes,
  type dayTargets,
  type targets,
  NUTRIENT_KEYS,
} from "../db/schema.js";
import { ApiError, invalidInput, notFound } from "../errors.js";
import { gtinKey } from "../catalogue/gtin.js";
import { uuidv7 } from "../ids.js";
import type { z } from "zod";
import type { Entry, Ingredient, Product, ProductUpdate, recipe, linkFood } from "./schemas.js";
import { loadProduct, loadRecipe, productView, targetView } from "./views.js";
import type { DiaryContext } from "../access/guards.js";
import { canonical, type Tx } from "./writes.js";

export const lockFoodRegistry = (tx: Tx) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('shared-foods', 0))`);

const matchingUnit = (unit: string) =>
  (
    ({ g: "g", г: "g", kg: "kg", кг: "kg", ml: "ml", мл: "ml", l: "l", л: "l" }) as Record<
      string,
      string
    >
  )[unit.trim().toLowerCase()] ?? unit;

function productFacts(p: ProductUpdate): ProductFacts {
  return {
    kind: "product",
    brand: p.brand ?? null,
    barcode: p.barcode ?? null,
    gtinKey: p.barcode ? gtinKey(p.barcode) : null,
    foodKind: p.food_kind,
    variant: p.variant ?? null,
    preparation: p.preparation,
    provenance: p.provenance,
    basisAmount: p.basis_amount,
    basisUnit: p.basis_unit,
    nutrients: p.nutrients,
  };
}
const productComparison = (p: ProductFacts) => ({
  kind: p.kind,
  ...(p.foodKind === "product" && p.preparation?.state === "as_sold" && p.gtinKey
    ? {}
    : { barcode: p.barcode, gtinKey: p.gtinKey }),
  foodKind: p.foodKind,
  brand: p.brand,
  variant: p.variant,
  preparation: p.preparation,
  basisAmount: p.basisAmount,
  basisUnit: matchingUnit(p.basisUnit),
  nutrients: p.nutrients,
  provenance:
    p.provenance?.source === "label"
      ? {
          ...p.provenance,
          label: { ...p.provenance.label, basis_unit: matchingUnit(p.provenance.label.basis_unit) },
        }
      : p.provenance,
});
const fingerprint = (comparison: unknown) =>
  sql`encode(sha256(convert_to(${JSON.stringify(comparison)}::jsonb::text, 'UTF8')), 'hex')`;

async function foodIdentity(tx: Tx, key: string | null, fallbackId?: string) {
  if (key !== null) {
    const [existing] = await tx
      .select()
      .from(foodDefinitions)
      .where(eq(foodDefinitions.identityKey, key));
    if (existing) return existing.id;
  }
  if (fallbackId) return fallbackId;
  const id = uuidv7();
  await tx.insert(foodDefinitions).values({ id, identityKey: key });
  return id;
}

async function foodRevision(
  tx: Tx,
  foodId: string,
  content: ProductFacts | RecipeFacts,
  comparison: unknown,
) {
  const [existing] = await tx
    .select()
    .from(foodRevisions)
    .where(
      and(eq(foodRevisions.foodId, foodId), eq(foodRevisions.fingerprint, fingerprint(comparison))),
    );
  if (existing) return { revision: existing, created: false };
  const [revision] = await tx
    .insert(foodRevisions)
    .values({
      id: uuidv7(),
      foodId,
      content,
      fingerprint: fingerprint(comparison),
      catalogueRecordId:
        content.kind === "product" && content.provenance?.source === "dataset"
          ? content.provenance.catalogue_record_id
          : null,
    })
    .returning();
  if (!revision) throw new Error("food revision insert returned no row");
  return { revision, created: true };
}

export async function prepareProduct(
  tx: Tx,
  accountId: string,
  body: ProductUpdate,
  options: { updateId?: string; clientRef?: string } = {},
) {
  await lockFoodRegistry(tx);
  await checkReferences(tx, accountId, {
    recordIds: [
      ...(body.preferred_record_ids ?? []),
      ...(body.provenance?.source === "dataset" ? [body.provenance.catalogue_record_id] : []),
    ],
  });
  const content = productFacts(body);
  const key =
    content.foodKind === "product" && content.preparation?.state === "as_sold" && content.gtinKey
      ? `gtin:${content.gtinKey}`
      : content.preparation?.state === "as_published" && content.provenance?.source === "dataset"
        ? `catalogue:${content.provenance.catalogue_record_id}`
        : null;
  const [match] =
    key === null
      ? []
      : await tx
          .select()
          .from(products)
          .innerJoin(foodRevisions, eq(foodRevisions.id, products.revisionId))
          .innerJoin(foodDefinitions, eq(foodDefinitions.id, products.foodId))
          .where(
            and(
              eq(products.accountId, accountId),
              or(
                eq(foodDefinitions.identityKey, key),
                key.startsWith("gtin:")
                  ? and(
                      isNull(foodDefinitions.identityKey),
                      sql`${foodRevisions.content}->'preparation' = 'null'::jsonb`,
                      sql`${foodRevisions.content}->>'gtinKey' = ${content.gtinKey}`,
                    )
                  : undefined,
              ),
            ),
          )
          .orderBy(sql`${foodDefinitions.identityKey} IS NULL`, products.id)
          .limit(1);
  const existing =
    match && productView(match.products, match.food_revisions, match.food_definitions.identityKey);
  if (
    match &&
    match.products.id !== options.updateId &&
    (options.updateId !== undefined ||
      match.food_revisions.content.kind !== "product" ||
      canonical(productComparison(match.food_revisions.content)) !==
        canonical(productComparison(content)))
  ) {
    throw new ApiError(
      409,
      "food_identity_conflict",
      "This food has different saved details. Reuse it or explicitly update this profile's link.",
      {
        product: existing,
        ...(options.clientRef ? { client_ref: options.clientRef } : {}),
      },
    );
  }
  if (existing && !options.updateId) return { existing, values: null };
  const previous = options.updateId
    ? await loadProduct(tx, accountId, options.updateId)
    : undefined;
  const foodId = await foodIdentity(
    tx,
    key,
    key === null && previous?.identity_key === null ? previous.food_id : undefined,
  );
  const { revision } = await foodRevision(tx, foodId, content, productComparison(content));
  return {
    existing,
    values: {
      foodId,
      revisionId: revision.id,
      name: body.name,
      recognitionDescription: body.recognition_description ?? null,
      preferredRecordIds: body.preferred_record_ids ?? [],
      note: body.note ?? null,
    },
  };
}

export async function retainProduct(tx: Tx, accountId: string, body: Product, clientRef?: string) {
  const { values, existing } = await prepareProduct(tx, accountId, body, { clientRef });
  if (existing) return { product: existing, outcome: "reused" as const };
  if (!values) throw new Error("product values missing");
  const id = uuidv7();
  await tx.insert(products).values({ id, accountId, ...values });
  const product = await loadProduct(tx, accountId, id);
  if (!product) throw new Error("product insert returned no row");
  return { product, outcome: "created" as const };
}

export async function prepareRecipe(
  tx: Tx,
  accountId: string,
  r: z.infer<typeof recipe>,
  previousId?: string,
) {
  await lockFoodRegistry(tx);
  await checkReferences(tx, accountId, itemReferences(r.ingredients));
  const partial = new Set(r.partial_nutrients ?? []);
  for (const key of NUTRIENT_KEYS) {
    if (partial.has(key) && r.nutrients[key] === undefined)
      throw invalidInput("a partial nutrient needs a stored lower-bound value");
    if (
      r.nutrients[key] !== undefined &&
      r.ingredients.some(
        (i) => i.nutrients[key] === undefined || i.partial_nutrients?.includes(key),
      ) &&
      !partial.has(key)
    )
      throw invalidInput(`recipe ${key} must be marked partial when an ingredient is incomplete`);
  }
  const previous = previousId ? await loadRecipe(tx, accountId, previousId) : undefined;
  if (
    !r.ingredients.length ||
    (r.servings == null && (r.yield_amount == null || r.yield_unit == null))
  )
    throw invalidInput("a reusable recipe needs ingredients and yield or servings");
  const resolved = await Promise.all(
    r.ingredients.map(async (i, n) => {
      const product = i.product_id ? await loadProduct(tx, accountId, i.product_id) : undefined;
      // Deleting or correcting a library link must not force an unchanged recipe onto new facts.
      const stored = previous?.ingredients[n];
      const unchanged =
        stored && canonical(sharedItemRow(i, n + 1)) === canonical(sharedItemRow(stored, n + 1));
      if (!product && !unchanged)
        throw invalidInput("each new recipe ingredient needs an owned product_id");
      return {
        ...sharedItemRow(i, n + 1),
        productRevisionId: product?.revision_id ?? stored?.food_revision_id ?? null,
      };
    }),
  );
  const content: RecipeFacts = {
    kind: "recipe",
    yieldAmount: r.yield_amount ?? null,
    yieldUnit: r.yield_unit ?? null,
    servings: r.servings ?? null,
    nutrients: r.nutrients,
    partialNutrients: [...partial],
  };
  const foodId = await foodIdentity(tx, null, previous?.food_id);
  const { revision, created } = await foodRevision(tx, foodId, content, {
    ...content,
    ingredients: resolved,
  });
  if (created)
    await tx
      .insert(recipeIngredients)
      .values(resolved.map((i) => ({ id: uuidv7(), recipeRevisionId: revision.id, ...i })));
  const ingredients = await tx
    .select()
    .from(recipeIngredients)
    .where(eq(recipeIngredients.recipeRevisionId, revision.id))
    .orderBy(recipeIngredients.position);
  return {
    foodId,
    revisionId: revision.id,
    name: r.name,
    recognitionDescription: r.recognition_description ?? null,
    ingredientDetails: Object.fromEntries(
      ingredients.map((i, n) => [
        i.id,
        { name: r.ingredients[n]?.name ?? "", note: r.ingredients[n]?.note ?? "" },
      ]),
    ),
    note: r.note ?? null,
  };
}

function sharedItemRow(item: Entry | Ingredient, position: number) {
  return {
    position,
    quantity: item.quantity,
    unit: item.unit,
    nutrients: item.nutrients,
    partialNutrients: [...new Set(item.partial_nutrients ?? [])],
    source: item.source,
    catalogueRecordId: item.catalogue_record_id ?? null,
    labelBasisAmount: item.label?.basis_amount ?? null,
    labelBasisUnit: item.label?.basis_unit ?? null,
    labelNutrients: item.label?.nutrients ?? null,
  };
}
export function itemRow(item: Entry, position: number) {
  return {
    ...sharedItemRow(item, position),
    name: item.name,
    note: item.note,
    productId: item.product_id ?? null,
    diaryOnlyReason: item.diary_only_reason ?? null,
  };
}

export async function entryRevision(tx: Tx, accountId: string, item: Entry) {
  if (item.product_id)
    return (await loadProduct(tx, accountId, item.product_id))?.revision_id ?? null;
  if (item.recipe_id) return (await loadRecipe(tx, accountId, item.recipe_id))?.revision_id ?? null;
  return null;
}

export async function linkSharedFood(tx: Tx, caller: DiaryContext, body: z.infer<typeof linkFood>) {
  await lockFoodRegistry(tx);
  const [allowed] = caller.grantId
    ? await tx
        .select()
        .from(connectionProfiles)
        .where(
          and(
            eq(connectionProfiles.grantId, caller.grantId),
            eq(connectionProfiles.accountId, body.source_profile_id),
          ),
        )
        .for("share")
    : [];
  if (!allowed)
    throw new ApiError(403, "profile_not_available", "This profile is not available here");
  const accountId = caller.accountId ?? "";
  const source =
    body.record_type === "products"
      ? await loadProduct(tx, body.source_profile_id, body.record_id)
      : await loadRecipe(tx, body.source_profile_id, body.record_id);
  if (!source) throw notFound("Food");
  const table = body.record_type === "products" ? products : recipes;
  const [existing] = await tx
    .select({ id: table.id, revisionId: table.revisionId })
    .from(table)
    .where(and(eq(table.accountId, accountId), eq(table.foodId, source.food_id)));
  if (existing && existing.revisionId !== source.revision_id)
    throw new ApiError(
      409,
      "food_identity_conflict",
      "This profile already uses another revision; read it before an explicit correction.",
      { id: existing.id },
    );
  const id = existing?.id ?? uuidv7();
  if (!existing) {
    const base = {
      id,
      accountId,
      foodId: source.food_id,
      revisionId: source.revision_id,
      name: body.name,
    };
    if (body.record_type === "products") await tx.insert(products).values(base);
    else {
      if (!("ingredients" in source)) throw new Error("recipe source mismatch");
      const ingredients = await tx
        .select()
        .from(recipeIngredients)
        .where(eq(recipeIngredients.recipeRevisionId, source.revision_id));
      for (const ingredient of ingredients) {
        if (!ingredient.productRevisionId) continue;
        const [revision] = await tx
          .select()
          .from(foodRevisions)
          .where(eq(foodRevisions.id, ingredient.productRevisionId));
        if (!revision) throw new Error("ingredient revision missing");
        await tx
          .insert(products)
          .values({
            id: uuidv7(),
            accountId,
            foodId: revision.foodId,
            revisionId: revision.id,
            name:
              source.ingredients.find((i) => i.id === ingredient.id)?.name ??
              `Ingredient ${ingredient.position}`,
          })
          .onConflictDoNothing({ target: [products.accountId, products.foodId] });
      }
      await tx.insert(recipes).values({
        ...base,
        ingredientDetails: Object.fromEntries(
          source.ingredients.map((i) => [i.id, { name: i.name, note: "" }]),
        ),
      });
    }
  }
  const food =
    body.record_type === "products"
      ? await loadProduct(tx, accountId, id)
      : await loadRecipe(tx, accountId, id);
  if (!food) throw new Error("food link missing");
  return {
    type: body.record_type === "products" ? ("product" as const) : ("recipe" as const),
    food,
    outcome: existing ? ("reused" as const) : ("created" as const),
  };
}

export async function pruneFoods(tx: Tx) {
  await lockFoodRegistry(tx);
  // Retain all revisions of identities still used by a diary, library or another live recipe.
  const unused = await tx.execute<{ id: string }>(sql`WITH RECURSIVE live(id) AS (
    SELECT food_id FROM products UNION SELECT food_id FROM recipes
    UNION SELECT r.food_id FROM entries e JOIN food_revisions r ON r.id=e.food_revision_id
    UNION SELECT p.food_id FROM live l JOIN food_revisions r ON r.food_id=l.id
      JOIN recipe_ingredients i ON i.recipe_revision_id=r.id JOIN food_revisions p ON p.id=i.product_revision_id
  ) SELECT id FROM food_definitions WHERE id NOT IN (SELECT id FROM live)`);
  const ids = unused.rows.map((row) => row.id);
  if (!ids.length) return;
  // Remove orphan recipe edges before deleting their ingredient revisions.
  await tx
    .delete(recipeIngredients)
    .where(
      inArray(
        recipeIngredients.recipeRevisionId,
        tx
          .select({ id: foodRevisions.id })
          .from(foodRevisions)
          .where(inArray(foodRevisions.foodId, ids)),
      ),
    );
  await tx.delete(foodDefinitions).where(inArray(foodDefinitions.id, ids));
}

/** AC-2: catalogue records must exist; product and recipe references must belong to this account. */
export async function checkReferences(
  tx: Tx,
  accountId: string,
  refs: { recordIds?: number[]; productIds?: string[]; recipeIds?: string[] },
): Promise<void> {
  const recordIds = [...new Set(refs.recordIds ?? [])];
  if (recordIds.length) {
    const found = await tx
      .select({ id: catalogueRecord.id })
      .from(catalogueRecord)
      .where(inArray(catalogueRecord.id, recordIds));
    if (found.length !== recordIds.length)
      throw invalidInput("catalogue_record_id does not refer to a catalogue record");
  }
  const productIds = [...new Set(refs.productIds ?? [])];
  if (productIds.length) {
    const found = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.accountId, accountId), inArray(products.id, productIds)));
    if (found.length !== productIds.length)
      throw invalidInput("product_id does not refer to a usual product of this account");
  }
  const recipeIds = [...new Set(refs.recipeIds ?? [])];
  if (recipeIds.length) {
    const found = await tx
      .select({ id: recipes.id })
      .from(recipes)
      .where(and(eq(recipes.accountId, accountId), inArray(recipes.id, recipeIds)));
    if (found.length !== recipeIds.length)
      throw invalidInput("recipe_id does not refer to a recipe of this account");
  }
}

export const itemReferences = (items: (Entry | Ingredient)[]) => ({
  recordIds: items.flatMap((i) => (i.catalogue_record_id == null ? [] : [i.catalogue_record_id])),
  productIds: items.flatMap((i) => (i.product_id == null ? [] : [i.product_id])),
  recipeIds: items.flatMap((i) => ("recipe_id" in i && i.recipe_id != null ? [i.recipe_id] : [])),
});

/**
 * DA-6: resolves a versioned update or delete. No affected row means the record is missing
 * (404) or was changed since it was read (409 with the current record).
 */
export async function versioned<T>(
  affected: T | undefined,
  what: string,
  current: () => Promise<unknown>,
): Promise<T> {
  if (affected !== undefined) return affected;
  const now = await current();
  if (now === undefined) throw notFound(what);
  throw new ApiError(
    409,
    "version_conflict",
    `${what} was changed since it was read; show both versions and ask before retrying with the current version`,
    now,
  );
}

/** Escapes LIKE wildcards so a search term is matched literally. */
export const contains = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

type Target = typeof targets.$inferSelect;

/** DA-8: the newest variant of the kind whose `effective_from` is on or before the day. */
function effectiveTarget(
  variants: Target[],
  kind: "normal" | "training",
  day: string,
): Target | null {
  let best: Target | null = null;
  for (const t of variants) {
    if (
      t.kind === kind &&
      t.effectiveFrom <= day &&
      (best === null || t.effectiveFrom > best.effectiveFrom)
    )
      best = t;
  }
  return best;
}

/** A day's target fields: the selected kind (normal when none), its selection version and the effective target. */
export function dayTargetView(
  date: string,
  selection: typeof dayTargets.$inferSelect | undefined,
  variants: Target[],
) {
  const kind = selection?.kind ?? "normal";
  const target = effectiveTarget(variants, kind, date);
  return {
    date,
    target_kind: kind,
    target_kind_selected: selection !== undefined,
    target_kind_version: selection?.version ?? null,
    target: target && targetView(target),
  };
}

/** Turns a unique violation into an input error with `message`. */
export async function uniqueOr<T>(message: string, write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    // Drizzle wraps driver errors; the PostgreSQL code is on the error or its cause.
    const codes = [error, error instanceof Error ? error.cause : undefined].map((e) =>
      typeof e === "object" && e !== null && "code" in e ? e.code : undefined,
    );
    if (codes.includes("23505")) throw invalidInput(message);
    throw error;
  }
}
