import { eq, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "../db/client.js";
import {
  connectionProfiles,
  type FoodPreparation,
  type FoodProvenance,
  type NutrientKey,
} from "../db/schema.js";
import type { DiaryContext } from "../access/guards.js";
import { invalidInput } from "../errors.js";
import { cursorBinding, decodeCursor, encodeCursor, positions } from "../paging.js";
import { contains } from "./records.js";
import type { foodsQuery } from "./schemas.js";
import { gtinKey } from "../catalogue/gtin.js";

interface FoodRow extends Record<string, unknown> {
  type: "product" | "recipe";
  id: string;
  version: number;
  food_id: string;
  revision_id: string;
  source_profile_id: string;
  name: string;
  food_kind: "basic" | "product" | "recipe" | null;
  brand: string | null;
  barcode: string | null;
  gtin_key: string | null;
  variant: string | null;
  recognition_description: string | null;
  preparation: FoodPreparation | null;
  provenance: FoodProvenance | null;
  basis_amount: number | null;
  basis_unit: string | null;
  servings: number | null;
  energy_kcal: number | null;
  partial_nutrients: NutrientKey[];
  last_used_at: Date | null;
  sort_key: string;
}

export async function listFoods(db: Db, caller: DiaryContext, query: z.infer<typeof foodsQuery>) {
  const accountId = caller.accountId ?? "";
  if (query.scope === "connection" && !caller.grantId)
    throw invalidInput("connection food lookup requires a ChatGPT connection");
  const profileIds =
    query.scope === "connection" && caller.grantId
      ? (
          await db
            .select({ id: connectionProfiles.accountId })
            .from(connectionProfiles)
            .where(eq(connectionProfiles.grantId, caller.grantId))
        )
          .map((p) => p.id)
          .sort()
      : [accountId];
  const result = await foodPage(db, accountId, profileIds, query);
  if (!query.q || query.cursor || result.items.length) return result;
  const allKinds =
    query.food_kind === "all"
      ? result
      : await foodPage(db, accountId, profileIds, { ...query, food_kind: "all", limit: 10 });
  const candidates = allKinds.items.length
    ? allKinds
    : await foodPage(db, accountId, profileIds, {
        ...query,
        q: undefined,
        food_kind: "all",
        sort: "recent",
        limit: 10,
      });
  return {
    ...result,
    fallback: {
      reason: allKinds.items.length
        ? "unclassified_or_other_kind"
        : "name_may_be_in_another_language",
      query: {
        scope: query.scope,
        food_kind: "all",
        sort: allKinds.items.length ? query.sort : "recent",
        ...(allKinds.items.length ? { q: query.q } : {}),
      },
      ...candidates,
    },
  };
}

async function foodPage(
  db: Db,
  accountId: string,
  profileIds: string[],
  query: z.infer<typeof foodsQuery>,
) {
  const profiles = `{${profileIds.join(",")}}`;
  const binding = cursorBinding(accountId, [
    "foods",
    profileIds,
    query.scope,
    query.q ?? null,
    query.food_kind,
    query.sort,
  ]);
  const after = query.cursor
    ? decodeCursor(
        binding,
        query.cursor,
        query.sort === "name" ? positions.foodName : positions.foodRecent,
      )
    : null;
  const order = query.sort === "name" ? sql`name COLLATE "C",type,id` : sql`sort_at DESC,type,id`;
  const continuation = !after
    ? sql``
    : query.sort === "name"
      ? sql`AND (name COLLATE "C",type,id) > (${after[0]},${after[1]},${after[2]}::uuid)`
      : sql`AND (sort_at < to_timestamp(${after[0]}::numeric) OR (sort_at = to_timestamp(${after[0]}::numeric) AND (type,id) > (${after[1]},${after[2]}::uuid)))`;
  const result = await db.execute<FoodRow>(sql`
    WITH product_uses AS (
      SELECT product_id,max(created_at) AS last_used_at FROM entries WHERE account_id=${accountId} AND product_id IS NOT NULL GROUP BY product_id
    ), recipe_uses AS (
      SELECT recipe_id,max(created_at) AS last_used_at FROM entries WHERE account_id=${accountId} AND recipe_id IS NOT NULL GROUP BY recipe_id
    ), foods AS (
      SELECT 'product'::text AS type,p.id,p.version,p.food_id,p.revision_id,p.account_id AS source_profile_id,p.name,
        v.content->>'foodKind' AS food_kind,v.content->>'brand' AS brand,v.content->>'barcode' AS barcode,v.content->>'gtinKey' AS gtin_key,v.content->>'variant' AS variant,
        p.recognition_description,v.content->'preparation' AS preparation,v.content->'provenance' AS provenance,
        (v.content->>'basisAmount')::double precision AS basis_amount,v.content->>'basisUnit' AS basis_unit,NULL::double precision AS servings,(v.content->'nutrients'->>'energy_kcal')::double precision AS energy_kcal,ARRAY[]::text[] AS partial_nutrients,
        u.last_used_at,coalesce(u.last_used_at,p.created_at) AS sort_at,
        concat_ws(' ',p.name,v.content->>'brand',v.content->>'variant',v.content->'preparation'->>'description',p.recognition_description) AS search_text
      FROM products p JOIN food_revisions v ON v.id=p.revision_id LEFT JOIN product_uses u ON u.product_id=p.id WHERE p.account_id=ANY(${profiles}::uuid[])
      UNION ALL
      SELECT 'recipe',r.id,r.version,r.food_id,r.revision_id,r.account_id,r.name,'recipe',NULL,NULL,NULL,NULL,r.recognition_description,NULL,NULL,
        (v.content->>'yieldAmount')::double precision,v.content->>'yieldUnit',(v.content->>'servings')::double precision,(v.content->'nutrients'->>'energy_kcal')::double precision,
        ARRAY(SELECT jsonb_array_elements_text(v.content->'partialNutrients')),
        u.last_used_at,coalesce(u.last_used_at,r.created_at),concat_ws(' ',r.name,r.recognition_description)
      FROM recipes r JOIN food_revisions v ON v.id=r.revision_id LEFT JOIN recipe_uses u ON u.recipe_id=r.id WHERE r.account_id=ANY(${profiles}::uuid[])
    )
    SELECT type,id,version,food_id,revision_id,source_profile_id,name,food_kind,brand,barcode,gtin_key,variant,recognition_description,preparation,provenance,
      basis_amount,basis_unit,servings,energy_kcal,partial_nutrients,last_used_at,
      ${query.sort === "name" ? sql`name` : sql`extract(epoch FROM sort_at)::text`} AS sort_key
    FROM foods WHERE true
      ${query.food_kind === "all" ? sql`` : query.food_kind === "unclassified" ? sql`AND food_kind IS NULL` : sql`AND food_kind=${query.food_kind}`}
      ${query.q ? sql`AND (search_text ILIKE ${contains(query.q)} OR barcode=${query.q} OR gtin_key=${gtinKey(query.q)})` : sql``}
      ${continuation} ORDER BY ${order} LIMIT ${query.limit + 1}`);
  const rows = result.rows.slice(0, query.limit);
  const last = rows.at(-1);
  const more = result.rows.length > query.limit && last !== undefined;
  return {
    items: rows.map(({ sort_key: _, ...food }) => food),
    next_cursor: more ? encodeCursor(binding, [last.sort_key, last.type, last.id]) : null,
    complete: !more,
  };
}
