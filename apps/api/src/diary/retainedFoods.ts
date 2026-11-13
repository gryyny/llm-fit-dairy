import { recipes, type NutrientKey } from "../db/schema.js";
import { invalidInput } from "../errors.js";
import { uuidv7 } from "../ids.js";
import {
  checkReferences,
  itemReferences,
  prepareRecipe,
  linkSharedFood,
  lockFoodRegistry,
  entryRevision,
  retainProduct,
} from "./records.js";
import { entry, type Entry, type LoggingEntry, type NewFoods } from "./schemas.js";
import type { DiaryContext } from "../access/guards.js";
import { loadRecipe } from "./views.js";
import type { Tx } from "./writes.js";

interface RetainedFood {
  client_ref: string;
  type: "product" | "recipe";
  id: string;
  food_id: string;
  revision_id: string;
  version: number;
  outcome: "created" | "reused";
}

export async function retainFoods(
  tx: Tx,
  caller: DiaryContext,
  items: LoggingEntry[],
  definitions: NewFoods = [],
) {
  const accountId = caller.accountId ?? "";
  await lockFoodRegistry(tx);
  const byRef = new Map(definitions.map((food) => [food.client_ref, food]));
  if (byRef.size !== definitions.length)
    throw invalidInput("new_foods client_ref values must be unique");
  const used = new Set<string>();
  const use = (ref: string, ingredient = false) => {
    const food = byRef.get(ref);
    if (
      !food ||
      (ingredient &&
        food.type !== "product" &&
        !(food.type === "link" && food.definition.record_type === "products"))
    )
      throw invalidInput(
        "food_ref must identify a supplied food; recipe ingredients may reference only products",
      );
    used.add(ref);
    return food;
  };
  for (const item of items) {
    if (!item.food_ref) continue;
    const food = use(item.food_ref);
    if (food.type === "recipe") {
      for (const ingredient of food.definition.ingredients)
        if (ingredient.food_ref) use(ingredient.food_ref, true);
    }
  }
  if (used.size !== definitions.length)
    throw invalidInput("new_foods contains an unused definition");
  const ingredients = definitions.flatMap((food) =>
    food.type === "recipe" ? food.definition.ingredients : [],
  );
  await checkReferences(tx, accountId, itemReferences([...items, ...ingredients]));
  const recipeIds = items.flatMap((item) => (item.recipe_id ? [item.recipe_id] : []));
  const recipePartial = new Map<string, NutrientKey[]>();
  for (const id of recipeIds) {
    const recipe = await loadRecipe(tx, accountId, id);
    if (recipe) recipePartial.set(id, recipe.partial_nutrients);
  }
  const retained = new Map<string, RetainedFood>();
  for (const food of definitions) {
    if (food.type !== "product") continue;
    const { product, outcome } = await retainProduct(
      tx,
      accountId,
      food.definition,
      food.client_ref,
    );
    retained.set(food.client_ref, {
      client_ref: food.client_ref,
      type: "product",
      id: product.id,
      food_id: product.food_id,
      revision_id: product.revision_id,
      version: product.version,
      outcome,
    });
  }
  for (const food of definitions) {
    if (food.type !== "link") continue;
    const linked = await linkSharedFood(tx, caller, food.definition);
    retained.set(food.client_ref, {
      client_ref: food.client_ref,
      type: linked.type,
      id: linked.food.id,
      food_id: linked.food.food_id,
      revision_id: linked.food.revision_id,
      version: linked.food.version,
      outcome: linked.outcome,
    });
    if ("partial_nutrients" in linked.food)
      recipePartial.set(linked.food.id, linked.food.partial_nutrients);
  }
  const resolve = (item: LoggingEntry): Entry => {
    const { food_ref, ...snapshot } = item;
    const food = food_ref === undefined ? undefined : retained.get(food_ref);
    if (food_ref !== undefined && !food) throw invalidInput("food_ref has not been resolved");
    const recipeId = food?.type === "recipe" ? food.id : snapshot.recipe_id;
    const inherited = (recipeId ? (recipePartial.get(recipeId) ?? []) : []).filter(
      (key) => snapshot.nutrients[key] !== undefined,
    );
    const partial = [...new Set([...(snapshot.partial_nutrients ?? []), ...inherited])];
    return entry.parse({
      ...snapshot,
      partial_nutrients: partial,
      ...(food ? { [food.type === "product" ? "product_id" : "recipe_id"]: food.id } : {}),
    });
  };
  for (const food of definitions) {
    if (food.type !== "recipe") continue;
    const ingredients = food.definition.ingredients.map(resolve);
    const id = uuidv7();
    const row = await prepareRecipe(tx, accountId, { ...food.definition, ingredients });
    await tx.insert(recipes).values({ id, accountId, ...row });
    const saved = await loadRecipe(tx, accountId, id);
    if (!saved) throw new Error("recipe insert returned no row");
    recipePartial.set(id, saved.partial_nutrients);
    retained.set(food.client_ref, {
      client_ref: food.client_ref,
      type: "recipe",
      id,
      food_id: row.foodId,
      revision_id: row.revisionId,
      version: 1,
      outcome: "created",
    });
  }
  return {
    entries: await Promise.all(
      items.map(async (item) => {
        const resolved = resolve(item);
        return { ...resolved, food_revision_id: await entryRevision(tx, accountId, resolved) };
      }),
    ),
    retained_foods: definitions.map((food) => {
      const found = retained.get(food.client_ref);
      if (!found) throw new Error("retained food result missing");
      return found;
    }),
  };
}
