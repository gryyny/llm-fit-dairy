import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  date,
  doublePrecision,
  foreignKey,
  integer,
  json,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const timestamptz = () => timestamp({ withTimezone: true, mode: "date" });
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/** CA-3: a catalogue value exactly as published, with its unit when the source attaches one. */
export interface PublishedValue {
  value: string;
  unit: string | null;
}

export const catalogueRelease = pgTable(
  "catalogue_release",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    source: text().notNull(),
    release: text().notNull(),
    archiveSha256: text().notNull(),
    readCount: bigint({ mode: "number" }).notNull(),
    recordCount: bigint({ mode: "number" }).notNull(),
    rejectedCount: bigint({ mode: "number" }).notNull(),
    rejectedReasons: jsonb().$type<Record<string, number>>().notNull(),
    importedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [unique().on(t.source, t.release)],
);

export const catalogueRecord = pgTable(
  "catalogue_record",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    releaseId: bigint({ mode: "number" })
      .notNull()
      .references(() => catalogueRelease.id),
    sourceId: text().notNull(),
    name: text(),
    nameEn: text(),
    brand: text(),
    barcode: text(),
    gtinKey: text(),
    nutrientBasis: text(),
    servingBasis: text(),
    preparation: text(),
    /** The source's own record type as published (USDA `data_type`); null where a source has none. */
    dataType: text(),
    nutrients: jsonb().$type<Record<string, PublishedValue>>().notNull(),
    search: tsvector().generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(name_en, '') || ' ' || coalesce(brand, ''))`,
    ),
  },
  (t) => [
    unique().on(t.releaseId, t.sourceId),
    index().on(t.gtinKey),
    index().on(t.barcode),
    index().using("gin", t.search),
  ],
);

export const nutrientDefinition = pgTable(
  "nutrient_definition",
  {
    releaseId: bigint({ mode: "number" })
      .notNull()
      .references(() => catalogueRelease.id),
    code: text().notNull(),
    name: text(),
    unit: text(),
  },
  (t) => [primaryKey({ columns: [t.releaseId, t.code] })],
);

/** A person who signs in (ID-1); Firebase establishes who they are, our service owns their diaries. */
export const users = pgTable("users", {
  id: uuid().primaryKey(),
  firebaseUid: text().notNull().unique(),
  displayName: text().notNull(),
  consentVersion: text(),
  consentAt: timestamptz(),
  createdAt: timestamptz().notNull().defaultNow(),
});

/**
 * A profile: one person's diary, exactly one per user (ID-1). Internal names keep "account"; the API,
 * tools and website say profile.
 */
export const accounts = pgTable("accounts", {
  id: uuid().primaryKey(),
  ownerUserId: uuid()
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  /** The name ChatGPT sees for this profile. */
  displayName: text().notNull(),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().defaultNow(),
});

/** A pending authorization request between `/oauth/authorize` and the user's decision (OA-3). */
export const oauthRequests = pgTable("oauth_requests", {
  id: uuid().primaryKey(),
  clientId: text().notNull(),
  redirectUri: text().notNull(),
  state: text(),
  codeChallenge: text().notNull(),
  resource: text().notNull(),
  scope: text().notNull(),
  expiresAt: timestamptz().notNull(),
});

/** A single-use authorization code, stored as a hash (OA-3). */
export const oauthCodes = pgTable("oauth_codes", {
  codeHash: text().primaryKey(),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  clientId: text().notNull(),
  redirectUri: text().notNull(),
  codeChallenge: text().notNull(),
  resource: text().notNull(),
  scope: text().notNull(),
  expiresAt: timestamptz().notNull(),
});

/** One ChatGPT connection: created at code exchange, listed and revoked on the website (OA-4). */
export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text().notNull(),
    resource: text().notNull(),
    scope: text().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    lastUsedAt: timestamptz(),
    revokedAt: timestamptz(),
  },
  (t) => [index().on(t.userId)],
);

/** ID-4: the profiles one ChatGPT connection may use; each was linked by that person's own approval. */
export const connectionProfiles = pgTable(
  "connection_profiles",
  {
    grantId: uuid()
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.grantId, t.accountId] }), index().on(t.accountId)],
);

/** ID-4: a single-use join link for adding another person's profile to a connection, stored as a hash. */
export const connectionInvites = pgTable(
  "connection_invites",
  {
    codeHash: text().primaryKey(),
    grantId: uuid()
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    expiresAt: timestamptz().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [index().on(t.grantId)],
);

/** Opaque access and refresh tokens, stored as SHA-256 (OA-4). A used refresh token keeps its row to detect reuse. */
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    tokenHash: text().primaryKey(),
    grantId: uuid()
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    kind: text().$type<"access" | "refresh">().notNull(),
    expiresAt: timestamptz().notNull(),
    usedAt: timestamptz(),
  },
  (t) => [
    index().on(t.grantId),
    check("oauth_tokens_kind", sql`${t.kind} IN ('access', 'refresh')`),
  ],
);

/** DA-3: the eight diary nutrients; a missing key means unknown, never zero. */
export const NUTRIENT_KEYS = [
  "energy_kcal",
  "protein_g",
  "carbohydrate_g",
  "sugars_g",
  "fat_g",
  "saturated_fat_g",
  "fibre_g",
  "salt_g",
] as const;
export type Nutrients = Partial<Record<(typeof NUTRIENT_KEYS)[number], number>>;
export type NutrientKey = (typeof NUTRIENT_KEYS)[number];
export interface FoodPreparation {
  state: "as_sold" | "as_published" | "other" | "unspecified";
  description: string | null;
}
export type FoodProvenance =
  | { source: "label"; label: { basis_amount: number; basis_unit: string; nutrients: Nutrients } }
  | { source: "dataset"; catalogue_record_id: number }
  | { source: "estimate" };
export type TargetValues = Partial<
  Record<(typeof NUTRIENT_KEYS)[number], { value?: number; min?: number; max?: number }>
>;

const accountId = () =>
  uuid()
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" });
const version = () => integer().notNull().default(1);
const timestamps = {
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz().notNull().defaultNow(),
};
const sourceCheck = (column: unknown) => sql`${column} IN ('label', 'dataset', 'estimate')`;

export interface BodyFields {
  height: { value: number; unit: "cm" | "in" } | null;
  date_of_birth?: string | null;
  age: { years: number; as_of: string } | null;
  activity: string | null;
  goal: string | null;
}
export interface GoalInputs {
  body_context?: { version: number; fields: BodyFields };
  weight?: { id: string; version: number; date: string; value: number; unit: "kg" | "lb" };
}
export const bodyContexts = pgTable("body_contexts", {
  accountId: accountId().primaryKey(),
  height: jsonb().$type<BodyFields["height"]>(),
  dateOfBirth: date({ mode: "string" }),
  age: jsonb().$type<BodyFields["age"]>(),
  activity: text(),
  goal: text(),
  version: version(),
  ...timestamps,
});

export const meals = pgTable(
  "meals",
  {
    id: uuid().primaryKey(),
    accountId: accountId(),
    diaryDate: date({ mode: "string" }).notNull(),
    label: text(),
    note: text(),
    version: version(),
    ...timestamps,
  },
  (t) => [index().on(t.accountId, t.diaryDate)],
);

export interface ProductFacts {
  kind: "product";
  brand: string | null;
  barcode: string | null;
  gtinKey: string | null;
  foodKind: "basic" | "product" | null;
  variant: string | null;
  preparation: FoodPreparation | null;
  provenance: FoodProvenance | null;
  basisAmount: number;
  basisUnit: string;
  nutrients: Nutrients;
}
export interface RecipeFacts {
  kind: "recipe";
  yieldAmount: number | null;
  yieldUnit: string | null;
  servings: number | null;
  nutrients: Nutrients;
  partialNutrients: NutrientKey[];
}

export const foodDefinitions = pgTable("food_definitions", {
  id: uuid().primaryKey(),
  identityKey: text().unique(),
});
export const foodRevisions = pgTable(
  "food_revisions",
  {
    id: uuid().primaryKey(),
    foodId: uuid()
      .notNull()
      .references(() => foodDefinitions.id, { onDelete: "cascade" }),
    content: jsonb().$type<ProductFacts | RecipeFacts>().notNull(),
    fingerprint: text().notNull(),
    catalogueRecordId: bigint({ mode: "number" }).references(() => catalogueRecord.id),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [unique().on(t.foodId, t.fingerprint), unique().on(t.foodId, t.id)],
);

const foodReference = {
  foodId: uuid().notNull(),
  revisionId: uuid().notNull(),
};

/** Stable personal IDs; reusable facts are read from the chosen shared revision. */
export const products = pgTable(
  "products",
  {
    id: uuid().primaryKey(),
    accountId: accountId(),
    ...foodReference,
    name: text().notNull(),
    recognitionDescription: text(),
    preferredRecordIds: bigint({ mode: "number" })
      .array()
      .notNull()
      .default(sql`'{}'`),
    note: text(),
    version: version(),
    ...timestamps,
  },
  (t) => [
    index().on(t.accountId),
    unique().on(t.accountId, t.foodId),
    foreignKey({
      columns: [t.foodId, t.revisionId],
      foreignColumns: [foodRevisions.foodId, foodRevisions.id],
    }),
  ],
);

export const recipes = pgTable(
  "recipes",
  {
    id: uuid().primaryKey(),
    accountId: accountId(),
    ...foodReference,
    name: text().notNull(),
    recognitionDescription: text(),
    ingredientDetails: jsonb().$type<Record<string, { name: string; note: string }>>().notNull(),
    note: text(),
    version: version(),
    ...timestamps,
  },
  (t) => [
    index().on(t.accountId),
    unique().on(t.accountId, t.foodId),
    foreignKey({
      columns: [t.foodId, t.revisionId],
      foreignColumns: [foodRevisions.foodId, foodRevisions.id],
    }),
  ],
);

/** Columns shared by meal entries and recipe ingredients: values as supplied plus one source (DA-4, DA-5). */
const sourcedItem = {
  position: integer().notNull(),
  quantity: doublePrecision().notNull(),
  unit: text().notNull(),
  nutrients: jsonb().$type<Nutrients>().notNull(),
  partialNutrients: text()
    .array()
    .$type<NutrientKey[]>()
    .notNull()
    .default(sql`'{}'`),
  source: text().$type<"label" | "dataset" | "estimate">().notNull(),
  catalogueRecordId: bigint({ mode: "number" }).references(() => catalogueRecord.id),
  labelBasisAmount: doublePrecision(),
  labelBasisUnit: text(),
  labelNutrients: jsonb().$type<Nutrients>(),
};

export const entries = pgTable(
  "entries",
  {
    id: uuid().primaryKey(),
    accountId: accountId(),
    mealId: uuid()
      .notNull()
      .references(() => meals.id, { onDelete: "cascade" }),
    ...sourcedItem,
    name: text().notNull(),
    note: text().notNull(),
    productId: uuid().references(() => products.id, { onDelete: "set null" }),
    foodRevisionId: uuid().references(() => foodRevisions.id),
    diaryOnlyReason: text().$type<"one_off_restaurant" | "insufficient_recipe_details">(),
    recipeId: uuid().references(() => recipes.id, { onDelete: "set null" }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    index().on(t.mealId),
    index().on(t.accountId),
    check("entries_source", sourceCheck(t.source)),
  ],
);

export const recipeIngredients = pgTable(
  "recipe_ingredients",
  {
    id: uuid().primaryKey(),
    recipeRevisionId: uuid()
      .notNull()
      .references(() => foodRevisions.id, { onDelete: "cascade" }),
    productRevisionId: uuid().references(() => foodRevisions.id),
    ...sourcedItem,
  },
  (t) => [
    index().on(t.recipeRevisionId),
    index().on(t.productRevisionId),
    check("recipe_ingredients_source", sourceCheck(t.source)),
  ],
);

export const targets = pgTable(
  "targets",
  {
    id: uuid().primaryKey(),
    accountId: accountId(),
    kind: text().$type<"normal" | "training">().notNull(),
    effectiveFrom: date({ mode: "string" }).notNull(),
    values: jsonb().$type<TargetValues>().notNull(),
    note: text(),
    rationale: text(),
    inputs: jsonb().$type<GoalInputs>(),
    version: version(),
    ...timestamps,
  },
  (t) => [
    unique().on(t.accountId, t.kind, t.effectiveFrom),
    check("targets_kind", sql`${t.kind} IN ('normal', 'training')`),
  ],
);

/** The selected target kind for a diary day; a day without a row uses the normal-day variant (DA-8). */
export const dayTargets = pgTable(
  "day_targets",
  {
    accountId: accountId(),
    diaryDate: date({ mode: "string" }).notNull(),
    kind: text().$type<"normal" | "training">().notNull(),
    version: version(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.diaryDate] }),
    check("day_targets_kind", sql`${t.kind} IN ('normal', 'training')`),
  ],
);

export const weights = pgTable(
  "weights",
  {
    id: uuid().primaryKey(),
    accountId: accountId(),
    measuredOn: date({ mode: "string" }).notNull(),
    value: doublePrecision().notNull(),
    unit: text().$type<"kg" | "lb">().notNull(),
    note: text(),
    version: version(),
    ...timestamps,
  },
  (t) => [
    index().on(t.accountId, t.measuredOn),
    check("weights_unit", sql`${t.unit} IN ('kg', 'lb')`),
  ],
);

/** CA-6: one chat-confirmed same-food assertion per account, stored as an ordered pair. */
export const foodLinks = pgTable(
  "food_links",
  {
    accountId: accountId(),
    recordA: bigint({ mode: "number" })
      .notNull()
      .references(() => catalogueRecord.id),
    recordB: bigint({ mode: "number" })
      .notNull()
      .references(() => catalogueRecord.id),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.recordA, t.recordB] }),
    index().on(t.accountId, t.recordB),
    check("food_links_order", sql`${t.recordA} < ${t.recordB}`),
  ],
);

/** DA-9: the stored result of each chat-data write, per connection and request ID. */
export const requestResults = pgTable(
  "request_results",
  {
    grantId: uuid()
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    accountId: uuid().references(() => accounts.id, { onDelete: "cascade" }),
    requestId: text().notNull(),
    fingerprint: text().notNull(),
    status: integer().notNull(),
    body: json().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.grantId, t.requestId] })],
);
