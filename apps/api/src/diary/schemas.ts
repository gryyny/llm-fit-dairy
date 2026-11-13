import { z } from "zod";
import { NUTRIENT_KEYS } from "../db/schema.js";
import { UUID } from "../ids.js";

const text = (max: number) => z.string().trim().min(1).max(max);
const note = z.string().max(4000);
const amount = z.number().nonnegative();
const positive = z.number().positive();
export const isoDate = z.iso.date();
export const uuid = z.string().regex(UUID);
export const profileName = z.strictObject({ name: text(60) });
const recordId = z.number().int().positive();
const kind = z.enum(["normal", "training"]);

/** DA-3: only the eight diary nutrients; unknown keys are rejected. */
const nutrients = z.strictObject(
  Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, amount.optional()])) as Record<
    (typeof NUTRIENT_KEYS)[number],
    z.ZodOptional<typeof amount>
  >,
);

const label = z
  .strictObject({ basis_amount: positive, basis_unit: text(50), nutrients })
  .describe(
    "Actual nutrition label read or supplied; copy its printed basis and values. User agreement or a package front is not label evidence.",
  );
const partialNutrients = z
  .array(z.enum(NUTRIENT_KEYS))
  .max(NUTRIENT_KEYS.length)
  .describe(
    "Numeric lower bounds with missing contributions. Omit entirely unknown nutrient values; mark recipe totals when any ingredient contribution is missing or partial.",
  );

const foodPreparation = z
  .strictObject({
    state: z.enum(["as_sold", "as_published", "other", "unspecified"]),
    description: text(200).nullable().default(null),
  })
  .refine(
    (p) => p.state !== "other" || p.description !== null,
    "other preparation requires a description",
  );
const foodProvenance = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("label"), label }),
  z.strictObject({ source: z.literal("dataset"), catalogue_record_id: recordId }),
  z.strictObject({ source: z.literal("estimate") }),
]);

/** Fields of an entry or recipe ingredient. Values are for the eaten amount, as supplied (DA-4). */
const itemShape = {
  name: text(200),
  quantity: positive,
  unit: text(50),
  nutrients,
  partial_nutrients: partialNutrients.optional(),
  source: z
    .enum(["label", "dataset", "estimate"])
    .describe(
      "Actual evidence: a read nutrition label, one read catalogue record, or an estimate. Accepted numbers do not establish new evidence; explain mixed origins in the note.",
    ),
  note,
  catalogue_record_id: recordId.nullable().optional(),
  product_id: uuid.nullable().optional(),
  label: label.nullable().optional(),
};

type ItemFields = z.infer<z.ZodObject<typeof itemShape>>;

/** DA-5: one source per item; a dataset item names its record and a label item carries the label basis. */
function sourceRule(item: ItemFields, ctx: z.RefinementCtx) {
  for (const key of item.partial_nutrients ?? []) {
    if (item.nutrients[key] === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["partial_nutrients"],
        message: "a partial nutrient needs a stored lower-bound value",
      });
  }
  if (item.source === "dataset" && item.catalogue_record_id == null) {
    ctx.addIssue({
      code: "custom",
      path: ["catalogue_record_id"],
      message: "dataset source requires catalogue_record_id",
    });
  }
  if (item.source === "label" && item.label == null) {
    ctx.addIssue({
      code: "custom",
      path: ["label"],
      message: "label source requires the label basis and values",
    });
  }
}

const diaryOnlyReason = z.enum(["one_off_restaurant", "insufficient_recipe_details"]);
const entryShape = {
  ...itemShape,
  recipe_id: uuid.nullable().optional(),
  diary_only_reason: diaryOnlyReason.nullable().optional(),
};
export const entry = z
  .strictObject(entryShape)
  .superRefine(sourceRule)
  .refine(
    (e) => [e.product_id, e.recipe_id, e.diary_only_reason].filter((id) => id != null).length <= 1,
    "use at most one reusable food reference or diary-only exception",
  );
const ingredient = z.strictObject(itemShape).superRefine(sourceRule);
/** Nutrients in a correction are merged into the stored ones; null clears a value back to unknown. */
const nutrientChanges = z.strictObject(
  Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, amount.nullable().optional()])) as Record<
    (typeof NUTRIENT_KEYS)[number],
    z.ZodOptional<z.ZodNullable<typeof amount>>
  >,
);
export const entryPatch = z
  .strictObject({ ...entryShape, nutrients: nutrientChanges })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "at least one field is required");
export type Entry = z.infer<typeof entry>;
export type Ingredient = z.infer<typeof ingredient>;

export const mealPatch = z
  .strictObject({ diary_date: isoDate, label: text(100).nullable(), note: note.nullable() })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "at least one field is required");

export const product = z.strictObject({
  name: text(200),
  brand: text(200).nullable().optional(),
  barcode: text(64).nullable().optional(),
  food_kind: z.enum(["basic", "product"]),
  variant: text(200).nullable().optional(),
  recognition_description: text(1000).nullable().optional(),
  preparation: foodPreparation,
  provenance: foodProvenance,
  basis_amount: positive,
  basis_unit: text(50),
  nutrients,
  preferred_record_ids: z.array(recordId).max(50).optional(),
  note: note.nullable().optional(),
});

export const productUpdate = product.extend({
  food_kind: product.shape.food_kind.nullable(),
  preparation: foodPreparation.nullable(),
  provenance: foodProvenance.nullable(),
});
export type Product = z.infer<typeof product>;
export type ProductUpdate = z.infer<typeof productUpdate>;

export const recipe = z.strictObject({
  name: text(200),
  recognition_description: text(1000).nullable().optional(),
  yield_amount: positive.nullable().optional(),
  yield_unit: text(50).nullable().optional(),
  servings: positive.nullable().optional(),
  nutrients,
  partial_nutrients: partialNutrients.optional(),
  note: note.nullable().optional(),
  ingredients: z.array(ingredient).max(200),
});

const clientRef = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const loggingEntry = z
  .strictObject({ ...entryShape, food_ref: clientRef.optional() })
  .superRefine(sourceRule)
  .refine(
    (e) =>
      [e.product_id, e.recipe_id, e.food_ref, e.diary_only_reason].filter((id) => id != null)
        .length === 1,
    "each entry needs one existing food ID, food_ref, or diary_only_reason",
  );
const loggingIngredient = z
  .strictObject({ ...itemShape, food_ref: clientRef.optional() })
  .superRefine(sourceRule)
  .refine(
    (i) => [i.product_id, i.food_ref].filter((id) => id != null).length === 1,
    "each retained ingredient needs product_id or food_ref",
  );
export const linkFood = z.strictObject({
  source_profile_id: uuid,
  record_type: z.enum(["products", "recipes"]),
  record_id: uuid,
  name: text(200),
});
export const newFoods = z
  .array(
    z.discriminatedUnion("type", [
      z.strictObject({ client_ref: clientRef, type: z.literal("link"), definition: linkFood }),
      z.strictObject({ client_ref: clientRef, type: z.literal("product"), definition: product }),
      z.strictObject({
        client_ref: clientRef,
        type: z.literal("recipe"),
        definition: recipe
          .extend({
            ingredients: z.array(loggingIngredient).min(1).max(200),
          })
          .refine(
            (r) => r.servings != null || (r.yield_amount != null && r.yield_unit != null),
            "a retained recipe needs a usable yield or servings",
          ),
      }),
    ]),
  )
  .max(100);
export const addEntries = z.strictObject({
  entries: z.array(loggingEntry).min(1).max(100),
  new_foods: newFoods.optional(),
});
export const newMeal = addEntries.extend({
  diary_date: isoDate,
  label: text(100).nullable().optional(),
  note: note.nullable().optional(),
});
export type LoggingEntry = z.infer<typeof loggingEntry>;
export type NewFoods = z.infer<typeof newFoods>;

const bound = z
  .strictObject({ value: amount.optional(), min: amount.optional(), max: amount.optional() })
  .refine(
    (b) => b.value !== undefined || b.min !== undefined || b.max !== undefined,
    "give value, min or max",
  )
  .refine(
    (b) => b.min === undefined || b.max === undefined || b.min <= b.max,
    "min must not exceed max",
  );

const bodyFields = z.strictObject({
  height: z.strictObject({ value: positive, unit: z.enum(["cm", "in"]) }).nullable(),
  // Older target snapshots omit this field and must remain readable unchanged.
  date_of_birth: isoDate
    .refine((birth) => {
      const today = new Date().toISOString().slice(0, 10);
      const years = Number(today.slice(0, 4)) - Number(birth.slice(0, 4));
      return years - (today.slice(5) < birth.slice(5) ? 1 : 0) >= 18;
    }, "date_of_birth must be for an adult aged 18 or over")
    .nullable()
    .optional(),
  age: z.strictObject({ years: z.number().int().min(18), as_of: isoDate }).nullable(),
  activity: text(1000).nullable(),
  goal: text(1000).nullable(),
});
export const bodyPatch = bodyFields
  .partial()
  .refine((p) => Object.keys(p).length > 0, "at least one field is required");
export const bodyVersionQuery = z.strictObject({ version: z.coerce.number().int().nonnegative() });
const goalInputs = z
  .strictObject({
    body_context: z
      .strictObject({ version: z.number().int().positive(), fields: bodyFields })
      .optional(),
    weight: z
      .strictObject({
        id: uuid,
        version: z.number().int().positive(),
        date: isoDate,
        value: positive,
        unit: z.enum(["kg", "lb"]),
      })
      .optional(),
  })
  .refine((i) => Object.keys(i).length > 0, "give at least one input snapshot");

export const target = z.strictObject({
  rationale: note.nullable().optional(),
  inputs: goalInputs.nullable().optional(),
  kind,
  effective_from: isoDate,
  values: z
    .strictObject(
      Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, bound.optional()])) as Record<
        (typeof NUTRIENT_KEYS)[number],
        z.ZodOptional<typeof bound>
      >,
    )
    .refine((v) => Object.keys(v).length > 0, "at least one nutrient target is required"),
  note: note.nullable().optional(),
});

export const weight = z.strictObject({
  date: isoDate,
  value: positive,
  unit: z.enum(["kg", "lb"]),
  note: note.nullable().optional(),
});

export const dayTarget = z.strictObject({ kind });

export const versionQuery = z.strictObject({ version: z.coerce.number().int().positive() });
export const optionalVersionQuery = z.strictObject({
  version: z.coerce.number().int().positive().optional(),
});

const limit = (max: number) => z.coerce.number().int().min(1).max(max).default(max);
const cursor = z.string().min(1).max(2000).optional();
const q = z.string().trim().min(1).max(200);

export const diaryRange = z
  .strictObject({ from: isoDate, to: isoDate })
  .refine((r) => r.from <= r.to, "from must not be after to")
  .refine(
    (r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 < 31,
    "a diary read covers at most 31 days",
  );
export const searchQuery = z.strictObject({ q, limit: limit(50), cursor });
export const namedListQuery = z.strictObject({ q: q.optional(), limit: limit(50), cursor });
export const foodsQuery = z.strictObject({
  scope: z.enum(["personal", "connection"]).default("personal"),
  q: q.optional(),
  food_kind: z.enum(["all", "basic", "product", "recipe", "unclassified"]).default("all"),
  sort: z.enum(["recent", "name"]).default("recent"),
  limit: limit(50),
  cursor,
});
export const targetListQuery = z.strictObject({
  kind: kind.optional(),
  effective_on: isoDate.optional(),
  limit: limit(50),
  cursor,
});
export const weightListQuery = z
  .strictObject({ from: isoDate.optional(), to: isoDate.optional(), limit: limit(50), cursor })
  .refine((r) => !r.from || !r.to || r.from <= r.to, "from must not be after to");
export const catalogueQuery = z
  .strictObject({
    q: q.optional(),
    gtin: z.string().trim().min(1).max(64).optional(),
    source: z.enum(["ciqual", "bls", "usda", "off"]).optional(),
    data_type: text(200).optional(),
    view: z.enum(["summary", "full"]).default("full"),
    limit: limit(20),
    cursor,
  })
  .refine((r) => (r.q === undefined) !== (r.gtin === undefined), "give exactly one of q or gtin");
export const recordIdParam = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const recordTypes = [
  "meals",
  "entries",
  "products",
  "recipes",
  "targets",
  "weights",
] as const;
export const recordType = z.enum(recordTypes);
