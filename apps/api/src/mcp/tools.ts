import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { NUTRIENT_KEYS } from "../db/schema.js";
import {
  product,
  productUpdate,
  recipe,
  loggingEntry,
  newFoods,
  linkFood,
  bodyPatch,
  profileName,
  target,
} from "../diary/schemas.js";

interface ApiResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/** Our own `/api/v1`, called with the MCP caller's access token (MC-1). */
export interface DiaryApi {
  request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options?: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      requestId?: string;
    },
  ): Promise<ApiResult>;
}

const profileId = z
  .uuid()
  .optional()
  .describe(
    "Profile ID from list_profiles. May be omitted only when this connection has a single profile; with several, always pass the person meant.",
  );
const requestId = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[\x21-\x7e]+$/)
  .describe(
    "New unique ID for each intended write (e.g. a UUID). Reuse the same ID only to retry the same write after a lost response.",
  );
const version = z
  .number()
  .int()
  .positive()
  .describe(
    "The record's version as last read; a mismatch returns version_conflict with the current record.",
  );
const isoDate = z.iso.date().describe("Local calendar date, YYYY-MM-DD.");
const cursor = z
  .string()
  .optional()
  .describe("next_cursor from the previous page of the same query.");
const nutrients = z
  .strictObject(
    Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, z.number().nonnegative().optional()])),
  )
  .describe(
    "Values for the stated amount: energy in kcal, others in grams. Omit unknown values; never put 0 for unknown.",
  );
const label = z
  .strictObject({
    basis_amount: z.number().positive(),
    basis_unit: z.string().min(1),
    nutrients,
  })
  .describe("The label's own basis and values, copied as printed (e.g. per 100 g).");
const item = {
  name: z.string().min(1).max(200),
  quantity: z.number().positive(),
  unit: z.string().min(1).max(50),
  nutrients,
  partial_nutrients: z
    .array(z.enum(NUTRIENT_KEYS))
    .optional()
    .describe(
      "Nutrients whose numeric value is only a lower bound because a contribution is missing. Omit entirely unknown values.",
    ),
  source: z
    .enum(["label", "dataset", "estimate"])
    .describe(
      "Actual evidence: dataset needs one read catalogue_record_id; label needs an actual read nutrition label. User confirmation alone is not label evidence.",
    ),
  note: z
    .string()
    .max(4000)
    .describe("Assumptions, calculations, corrections or mixed origins; may be empty."),
  catalogue_record_id: z.number().int().positive().nullable().optional(),
  product_id: z.uuid().nullable().optional().describe("Usual product used, as provenance."),
  label: label.nullable().optional(),
};
const entry = z.strictObject({
  ...item,
  recipe_id: z.uuid().nullable().optional(),
  diary_only_reason: z
    .enum(["one_off_restaurant", "insufficient_recipe_details"])
    .nullable()
    .optional(),
});
const bound = z.strictObject({
  value: z.number().nonnegative().optional(),
  min: z.number().nonnegative().optional(),
  max: z.number().nonnegative().optional(),
});
const productFields = product.shape;
const recipeFields = {
  ...recipe.shape,
  nutrients: nutrients.describe("Whole-recipe values as supplied."),
};
const targetFields = {
  rationale: target.shape.rationale,
  inputs: target.shape.inputs,
  kind: z.enum(["normal", "training"]),
  effective_from: isoDate,
  values: z
    .strictObject(Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, bound.optional()])))
    .describe("Per nutrient: value, or min and/or max."),
  note: z.string().max(4000).nullable().optional(),
};
const weightFields = {
  date: isoDate,
  value: z.number().positive(),
  unit: z.enum(["kg", "lb"]),
  note: z.string().max(4000).nullable().optional(),
};

/** Annotations (MC-2); writes carry request_id, so repeating identical arguments replays. */
const hints = (readOnly: boolean, destructive: boolean) => ({
  readOnlyHint: readOnly,
  destructiveHint: destructive,
  idempotentHint: true,
  openWorldHint: false,
});
const READ = hints(true, false);
const ADD = hints(false, false);
const CHANGE = hints(false, true);
const _meta = { securitySchemes: [{ type: "oauth2", scopes: ["diary"] }] };

/** Drops server timestamps from tool output; chat needs IDs and versions, not when rows were written. */
function withoutTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTimestamps);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "created_at" && key !== "updated_at")
        .map(([key, v]) => [key, withoutTimestamps(v)]),
    );
  }
  return value;
}

/** CH-2/CH-3: the API's JSON as the tool result, an error result when the API refused. */
function result(
  api: ApiResult,
  resourceMetadata: string,
  extra?: Record<string, unknown>,
): CallToolResult {
  const body = withoutTimestamps(api.body);
  const structured = {
    ...(typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : { value: body }),
    ...extra,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    ...(api.ok ? {} : { isError: true }),
    // OA-5: an expired or revoked token inside a tool call asks ChatGPT to reconnect.
    ...(api.status === 401
      ? {
          _meta: {
            "mcp/www_authenticate": [
              `Bearer resource_metadata="${resourceMetadata}", error="invalid_token", error_description="Reconnect the Food diary plugin to continue"`,
            ],
          },
        }
      : {}),
  };
}

const profileList = z.object({
  items: z.array(z.object({ profile_id: z.string(), name: z.string() })),
});

export function createServer(api: DiaryApi, resourceMetadata: string): McpServer {
  const server = new McpServer({ name: "food-diary", version: "2.3.0" });
  const done = (res: ApiResult, extra?: Record<string, unknown>) =>
    result(res, resourceMetadata, extra);

  /** MC-2: an omitted profile resolves to the connection's only profile; with several, the call must name one. */
  const inProfile = async (
    id: string | undefined,
    call: (path: string) => Promise<ApiResult>,
  ): Promise<CallToolResult> => {
    if (id !== undefined) return done(await call(`/profiles/${encodeURIComponent(id)}`));
    const listed = await api.request("GET", "/profiles");
    const parsed = profileList.safeParse(listed.body);
    if (!listed.ok || !parsed.success) return done(listed);
    const [only, ...others] = parsed.data.items;
    if (only && others.length === 0) {
      return done(await call(`/profiles/${only.profile_id}`), {
        profile_used: { profile_id: only.profile_id, name: only.name },
      });
    }
    return done({
      ok: false,
      status: 400,
      body: {
        code: "profile_required",
        message: "This connection reaches several profiles; pass profile_id for the person meant",
        profiles: parsed.data.items,
      },
    });
  };
  const write = (
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    request_id: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ) => api.request(method, path, { ...options, requestId: request_id });

  server.registerTool(
    "list_profiles",
    {
      title: "List profiles",
      description:
        "The profiles this ChatGPT connection can use, with names. Each is an independent person who joined with their own sign-in. Call when it is unclear whose diary is meant.",
      annotations: READ,
      _meta,
    },
    async () => done(await api.request("GET", "/profiles")),
  );

  server.registerTool(
    "add_profile",
    {
      title: "Invite a person's profile",
      description:
        "Creates a one-time link, valid for 30 minutes, for another person to add their own profile to this ChatGPT connection. They open it, sign in with their own Google or email/password account and approve. Only when the user explicitly asks; it never creates a profile or gives access to anyone without their approval.",
      inputSchema: z.strictObject({ request_id: requestId }),
      annotations: ADD,
      _meta,
    },
    async ({ request_id }) => done(await write("POST", "/profiles/invites", request_id)),
  );

  server.registerTool(
    "read_diary",
    {
      title: "Read diary days",
      description:
        "Meals with entries, weights, the day's target kind and effective target for each day from..to (at most 31 days).",
      inputSchema: z.strictObject({ profile_id: profileId, from: isoDate, to: isoDate }),
      annotations: READ,
      _meta,
    },
    async ({ profile_id, from, to }) =>
      inProfile(profile_id, (d) => api.request("GET", `${d}/diary`, { query: { from, to } })),
  );

  server.registerTool(
    "search_diary",
    {
      title: "Search diary",
      description:
        "Text search over logged entries, usual products and recipes, newest first. Paged.",
      inputSchema: z.strictObject({
        profile_id: profileId,
        q: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(50).optional(),
        cursor,
      }),
      annotations: READ,
      _meta,
    },
    async ({ profile_id, ...query }) =>
      inProfile(profile_id, (d) => api.request("GET", `${d}/search`, { query })),
  );

  server.registerTool(
    "read_profile",
    {
      title: "Read profile and body context",
      description:
        "Read the selected profile name/version and saved body facts: height, optional date_of_birth (YYYY-MM-DD), dated age, activity and goal. A missing context is null. Read before asking for missing details; meal logging never requires body setup.",
      inputSchema: z.strictObject({ profile_id: profileId }),
      annotations: READ,
      _meta,
    },
    async ({ profile_id }) => inProfile(profile_id, (d) => api.request("GET", d)),
  );
  server.registerTool(
    "update_profile",
    {
      title: "Rename a profile",
      description:
        "Change only the selected person's saved profile name, after they ask. Read its version with read_profile or list_profiles. Profile facts, goals and weight use their own tools.",
      inputSchema: z.strictObject({
        profile_id: profileId,
        request_id: requestId,
        version,
        name: profileName.shape.name,
      }),
      annotations: CHANGE,
      _meta,
    },
    async ({ profile_id, request_id, version, name }) =>
      inProfile(profile_id, (d) =>
        write("PATCH", d, request_id, { query: { version }, body: { name } }),
      ),
  );

  server.registerTool(
    "update_body_context",
    {
      title: "Update optional body context",
      description:
        "Save only supplied height, optional date_of_birth (YYYY-MM-DD), dated age, activity and overall goal after the person asks or agrees. Omitted fields stay unchanged; null clears a whole field. Age includes its as_of date and never ages automatically. Read first: version 0 is only for absent context. Weight history and nutrition targets stay separate and unchanged. Never store body facts in weight notes. consent_required needs the selected owner to review Settings; meal logging stays available.",
      inputSchema: z.strictObject({
        profile_id: profileId,
        request_id: requestId,
        version: z.number().int().nonnegative(),
        changes: bodyPatch,
      }),
      annotations: CHANGE,
      _meta,
    },
    async ({ profile_id, request_id, version, changes }) =>
      inProfile(profile_id, (d) =>
        write("PATCH", `${d}/body-context`, request_id, { query: { version }, body: changes }),
      ),
  );

  server.registerTool(
    "save_meal",
    {
      title: "Log a meal",
      description:
        "Logs a new meal with entries, or adds entries to an existing meal when meal_id is given. Every entry needs one existing product_id/recipe_id, food_ref, or diary_only_reason (one_off_restaurant/insufficient_recipe_details). Supply new_foods with product/recipe definitions or type=link to reuse an authorized shared definition. Recipe ingredients need product_id or food_ref. Definitions, personal links and entries save atomically. Report success and retention only from the returned record.",
      inputSchema: z.strictObject({
        profile_id: profileId,
        request_id: requestId,
        meal_id: z.uuid().optional().describe("Add to this existing meal instead of creating one."),
        diary_date: isoDate.optional().describe("Required for a new meal."),
        label: z.string().min(1).max(100).nullable().optional().describe("e.g. Breakfast"),
        note: z.string().max(4000).nullable().optional(),
        entries: z.array(loggingEntry).min(1).max(100),
        new_foods: newFoods.optional(),
      }),
      annotations: ADD,
      _meta,
    },
    async ({ profile_id, request_id, meal_id, entries, new_foods, ...meal }) =>
      inProfile(profile_id, (d) =>
        meal_id
          ? write("POST", `${d}/meals/${encodeURIComponent(meal_id)}/entries`, request_id, {
              body: { entries, new_foods },
            })
          : write("POST", `${d}/meals`, request_id, { body: { ...meal, entries, new_foods } }),
      ),
  );

  server.registerTool(
    "update_meal",
    {
      title: "Correct a meal",
      description: "Changes a meal's date, label or note.",
      inputSchema: z.strictObject({
        profile_id: profileId,
        request_id: requestId,
        meal_id: z.uuid(),
        version,
        diary_date: isoDate.optional(),
        label: z.string().min(1).max(100).nullable().optional(),
        note: z.string().max(4000).nullable().optional(),
      }),
      annotations: CHANGE,
      _meta,
    },
    async ({ profile_id, request_id, meal_id, version, ...body }) =>
      inProfile(profile_id, (d) =>
        write("PATCH", `${d}/meals/${encodeURIComponent(meal_id)}`, request_id, {
          query: { version },
          body,
        }),
      ),
  );

  server.registerTool(
    "update_entry",
    {
      title: "Correct an entry",
      description:
        "Changes only the given fields of one entry. Values are for the amount eaten and are never rescaled by the app: when quantity changes, send the recalculated nutrients with it. For a value-only correction send just the changed nutrient keys; others are kept. Returns the entry and the meal's new version.",
      inputSchema: z.strictObject({
        profile_id: profileId,
        request_id: requestId,
        entry_id: z.uuid(),
        version,
        changes: entry
          .extend({
            nutrients: z
              .strictObject(
                Object.fromEntries(
                  NUTRIENT_KEYS.map((k) => [k, z.number().nonnegative().nullable().optional()]),
                ),
              )
              .describe(
                "Only the nutrients that change; others are kept. null clears a value to unknown.",
              ),
          })
          .partial(),
      }),
      annotations: CHANGE,
      _meta,
    },
    async ({ profile_id, request_id, entry_id, version, changes }) =>
      inProfile(profile_id, (d) =>
        write("PATCH", `${d}/entries/${encodeURIComponent(entry_id)}`, request_id, {
          query: { version },
          body: changes,
        }),
      ),
  );

  server.registerTool(
    "delete_record",
    {
      title: "Delete a record",
      description:
        "Permanently deletes one meal (with its entries), entry, usual product, recipe, target or weight. Logged meals keep their values when a product or recipe is deleted.",
      inputSchema: z.strictObject({
        profile_id: profileId,
        request_id: requestId,
        record_type: z.enum(["meals", "entries", "products", "recipes", "targets", "weights"]),
        record_id: z.uuid(),
        version,
      }),
      annotations: CHANGE,
      _meta,
    },
    async ({ profile_id, request_id, record_type, record_id, version }) =>
      inProfile(profile_id, (d) =>
        write("DELETE", `${d}/${record_type}/${encodeURIComponent(record_id)}`, request_id, {
          query: { version },
        }),
      ),
  );

  /** Saved records: an additive save and a separate, destructive update (MC-2). */
  const saved = (
    collection: "products" | "recipes" | "targets" | "weights",
    noun: string,
    fields: z.ZodRawShape,
    descriptions: { save: string; update: string },
    updateFields: z.ZodRawShape = fields,
  ) => {
    const idKey = `${collection.slice(0, -1)}_id`;
    server.registerTool(
      `save_${collection.slice(0, -1)}`,
      {
        title: `Save a ${noun}`,
        description: descriptions.save,
        inputSchema: z.strictObject({ profile_id: profileId, request_id: requestId, ...fields }),
        annotations: ADD,
        _meta,
      },
      async (args: Record<string, unknown>) => {
        const { profile_id, request_id, ...body } = args as {
          profile_id?: string;
          request_id: string;
        } & Record<string, unknown>;
        return inProfile(profile_id, (d) =>
          write("POST", `${d}/${collection}`, request_id, { body }),
        );
      },
    );
    server.registerTool(
      `update_${collection.slice(0, -1)}`,
      {
        title: `Replace a ${noun}`,
        description: descriptions.update,
        inputSchema: z.strictObject({
          profile_id: profileId,
          request_id: requestId,
          [idKey]: z.uuid(),
          version,
          ...updateFields,
        }),
        annotations: CHANGE,
        _meta,
      },
      async (args: Record<string, unknown>) => {
        const {
          profile_id,
          request_id,
          version: read,
          [idKey]: id,
          ...body
        } = args as { profile_id?: string; request_id: string; version: number } & Record<
          string,
          unknown
        >;
        return inProfile(profile_id, (d) =>
          write("PUT", `${d}/${collection}/${encodeURIComponent(String(id))}`, request_id, {
            query: { version: read },
            body,
          }),
        );
      },
    );
  };

  saved(
    "products",
    "usual product",
    productFields,
    {
      save: "Retains a reusable basic food or product with explicit preparation and evidence. An eligible barcode or exact catalogue identity resolves one shared food. Identical facts reuse its revision; differing evidence is preserved as another revision. A profile already using different facts needs an explicit update. Names never establish identity.",
      update:
        "Replaces a usual product with the given fields. Meals already logged keep their values.",
    },
    productUpdate.shape,
  );
  saved("recipes", "recipe", recipeFields, {
    save: "Saves a recipe with retained ingredient products, usable yield/servings and whole-recipe values. To reuse a known shared recipe, use link_food or new_foods type=link.",
    update:
      "Replaces a recipe, including its whole ingredient list. Meals already logged keep their values.",
  });
  saved("targets", "target", targetFields, {
    save: "Saves a normal-day or training-day target variant from its effective date. Only after the person explicitly agreed to it.",
    update:
      "Replaces a saved target variant. Only after the person explicitly agreed to the change.",
  });
  saved("weights", "weight", weightFields, {
    save: "Records a dated weight in kg or lb as stated.",
    update: "Replaces a recorded weight.",
  });

  server.registerTool(
    "list_saved",
    {
      title: "List saved records",
      description:
        "Use record_type=foods for a compact personal library first; scope=connection searches foods of profiles already joined to this connection and returns source_profile_id for read_food/link_food. It never searches unapproved profiles. On a name miss, fallback contains bounded candidates, not confirmed matches; inspect brand/barcode and page its query before concluding absence. q matches names or exact barcode/eligible GTIN; food_kind=unclassified finds older foods without inferring metadata. Use all when classification is uncertain. Supports recent/name sorting; read_food opens full details. Also lists products/recipes, targets (newest first; kind and effective_on filter) or weights (from/to filter). For a current target, use its kind, effective_on and limit=1. Paged.",
      inputSchema: z.strictObject({
        profile_id: profileId,
        record_type: z.enum(["foods", "products", "recipes", "targets", "weights"]),
        scope: z
          .enum(["personal", "connection"])
          .optional()
          .describe("Only for record_type=foods; default personal."),
        food_kind: z.enum(["all", "basic", "product", "recipe", "unclassified"]).optional(),
        sort: z.enum(["recent", "name"]).optional(),
        q: z.string().min(1).max(200).optional(),
        kind: z.enum(["normal", "training"]).optional(),
        effective_on: isoDate.optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        limit: z.number().int().min(1).max(50).optional(),
        cursor,
      }),
      annotations: READ,
      _meta,
    },
    async ({ profile_id, record_type, ...query }) =>
      inProfile(profile_id, (d) => api.request("GET", `${d}/${record_type}`, { query })),
  );

  server.registerTool(
    "link_food",
    {
      title: "Add a shared food to a personal library",
      description:
        "Reuse a food or recipe from another profile already approved on this connection. Pass its source profile and library record ID from list_saved/read_food, and a name for the selected person's library. Creates a personal link to the same shared revision; never copies private notes or changes an existing chosen revision. Recipe ingredient definitions are retained too. For logging, use new_foods type=link in save_meal instead to make linking and logging atomic.",
      inputSchema: z.strictObject({
        profile_id: profileId,
        request_id: requestId,
        ...linkFood.shape,
      }),
      annotations: ADD,
      _meta,
    },
    async ({ profile_id, request_id, ...body }) =>
      inProfile(profile_id, (d) => write("POST", `${d}/foods/link`, request_id, { body })),
  );

  server.registerTool(
    "select_day_target",
    {
      title: "Choose a day's target kind",
      description:
        "Marks a diary day as a normal or training day. Days without a choice use the normal-day target. To change an existing choice, pass the day's target_kind_version from read_diary.",
      inputSchema: z.strictObject({
        profile_id: profileId,
        request_id: requestId,
        date: isoDate,
        kind: z.enum(["normal", "training"]),
        version: version
          .optional()
          .describe("The day's target_kind_version; omit only when the day has no choice yet."),
      }),
      annotations: CHANGE,
      _meta,
    },
    async ({ profile_id, request_id, date, kind, version }) =>
      inProfile(profile_id, (d) =>
        write("PUT", `${d}/days/${date}/target-kind`, request_id, {
          query: { version },
          body: { kind },
        }),
      ),
  );

  server.registerTool(
    "read_food",
    {
      title: "Read a saved food",
      description:
        "Read one selected reusable food, including its full nutrients, evidence and recipe ingredients. Search list_saved(record_type=foods) first.",
      inputSchema: z.strictObject({
        profile_id: profileId,
        record_type: z.enum(["products", "recipes"]),
        record_id: z.uuid(),
      }),
      annotations: READ,
      _meta,
    },
    async ({ profile_id, record_type, record_id }) =>
      inProfile(profile_id, (d) => api.request("GET", `${d}/${record_type}/${record_id}`)),
  );

  server.registerTool(
    "search_catalogue",
    {
      title: "Search the food catalogue",
      description:
        "Searches Ciqual, BLS, USDA and Open Food Facts by words (q) or barcode (gtin). Results are grouped by shared barcode and this profile's confirmed links; each record keeps its own published values and units, and USDA records carry their raw data_type (e.g. branded_food, foundation_food, sub_sample_food). Use summary to choose candidates, source/data_type to filter matches, then read_catalogue_record for full values. Filters never truncate linked groups. Missing brand is not proof of generic food. Paged by group.",
      inputSchema: z.strictObject({
        profile_id: profileId,
        q: z.string().min(1).max(200).optional(),
        source: z.enum(["ciqual", "bls", "usda", "off"]).optional(),
        data_type: z.string().min(1).max(200).optional(),
        view: z.enum(["summary", "full"]).optional(),
        gtin: z.string().min(1).max(64).optional(),
        limit: z.number().int().min(1).max(20).optional(),
        cursor,
      }),
      annotations: READ,
      _meta,
    },
    async ({ profile_id, ...query }) =>
      inProfile(profile_id, (d) => api.request("GET", `${d}/catalogue`, { query })),
  );

  server.registerTool(
    "read_catalogue_record",
    {
      title: "Read a catalogue record",
      description:
        "One catalogue record with its published values, units and bases, plus the records grouped with it for this profile.",
      inputSchema: z.strictObject({
        profile_id: profileId,
        record_id: z.number().int().positive(),
      }),
      annotations: READ,
      _meta,
    },
    async ({ profile_id, record_id }) =>
      inProfile(profile_id, (d) => api.request("GET", `${d}/catalogue/records/${record_id}`)),
  );

  server.registerTool(
    "set_food_link",
    {
      title: "Confirm or remove a same-food link",
      description:
        "Records (linked: true) or removes (linked: false) this profile's assertion that two catalogue records are the same food. Only after the person confirmed it; never changes logged meals.",
      inputSchema: z.strictObject({
        profile_id: profileId,
        request_id: requestId,
        record_a: z.number().int().positive(),
        record_b: z.number().int().positive(),
        linked: z.boolean(),
      }),
      annotations: CHANGE,
      _meta,
    },
    async ({ profile_id, request_id, record_a, record_b, linked }) =>
      inProfile(profile_id, (d) =>
        write(linked ? "PUT" : "DELETE", `${d}/food-links/${record_a}/${record_b}`, request_id),
      ),
  );

  return server;
}
