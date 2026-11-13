import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { PublishedValue } from "../db/schema.js";
import { invalidInput } from "../errors.js";
import { decodeCursor, encodeCursor, positions, type Page } from "../paging.js";
import { gtinKey } from "./gtin.js";

const SCAN_BATCH = 100;

export type CatalogueQuery = ({ q: string } | { gtin: string }) & {
  source?: "ciqual" | "bls" | "usda" | "off";
  data_type?: string;
  view?: "summary" | "full";
};

export interface CatalogueRecord extends Record<string, unknown> {
  id: number;
  source: string;
  release: string;
  source_id: string;
  name: string | null;
  name_en: string | null;
  brand: string | null;
  barcode: string | null;
  gtin_key: string | null;
  nutrient_basis: string | null;
  serving_basis: string | null;
  preparation: string | null;
  data_type: string | null;
  nutrients?: Record<string, PublishedValue & { name: string | null }>;
}

export interface CatalogueGroup {
  /** Records connected by shared eligible GTINs (CA-2) and this account's links (CA-6), each with its own values. */
  records: (CatalogueRecord & { matched: boolean })[];
  /** This account's confirmed links among the group's records. */
  links: { record_a: number; record_b: number }[];
}

interface Match extends Record<string, unknown> {
  id: number;
  rank: string;
}

/** Full-text prefix query over name and brand words, e.g. "oat fla" → `oat:* & fla:*`. */
function textQuery(q: string): SQL {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!words) throw invalidInput("q must contain at least one letter or digit");
  return sql`to_tsquery('simple', ${words.map((w) => `${w}:*`).join(" & ")})`;
}

/** Which records match, and how well: rank text is PostgreSQL's float4 output, exact on round trip. */
function baseMatch(query: CatalogueQuery): { where: SQL; rank: SQL } {
  if ("q" in query) {
    const tsq = textQuery(query.q);
    return { where: sql`r.search @@ ${tsq}`, rank: sql`ts_rank(r.search, ${tsq})` };
  }
  const key = gtinKey(query.gtin);
  return {
    where: key ? sql`r.gtin_key = ${key}` : sql`r.barcode = ${query.gtin}`,
    rank: sql`1::real`,
  };
}

function matchExpression(query: CatalogueQuery): { where: SQL; rank: SQL } {
  const match = baseMatch(query);
  return {
    rank: match.rank,
    where: sql`(${match.where})
    ${query.source ? sql`AND rel.source = ${query.source}` : sql``}
    ${query.data_type ? sql`AND r.data_type = ${query.data_type}` : sql``}`,
  };
}

/**
 * Each published value is returned with its release's nutrient definition name (CA-1), e.g. Ciqual
 * "400" → "Water (g/100g)"; the name is null where the source's code is self-describing (OFF).
 */
const summaryColumns = sql`r.id::int AS id, rel.source, rel.release, r.source_id, r.name, r.name_en, r.brand,
  r.barcode, r.gtin_key, r.nutrient_basis, r.serving_basis, r.preparation, r.data_type`;
const recordColumns = sql`${summaryColumns},
  coalesce((
    SELECT jsonb_object_agg(n.key, n.value || jsonb_build_object('name', d.name))
    FROM jsonb_each(r.nutrients) n
    LEFT JOIN nutrient_definition d ON d.release_id = r.release_id AND d.code = n.key
  ), '{}'::jsonb) AS nutrients`;

/**
 * The connected records around one record over shared GTIN keys and only this account's links.
 * `UNION` discards rows already reached, so cycles terminate; removing a link leaves any other path.
 */
async function groupOf(
  db: Db,
  accountId: string,
  id: number,
  match: { where: SQL; rank: SQL },
  summary = false,
) {
  const result = await db.execute<CatalogueRecord & { rank: string | null }>(sql`
    WITH RECURSIVE grp(id) AS (
      SELECT ${id}::bigint
      UNION
      SELECT n.id FROM grp g CROSS JOIN LATERAL (
        SELECT CASE WHEN l.record_a = g.id THEN l.record_b ELSE l.record_a END AS id
        FROM food_links l
        WHERE l.account_id = ${accountId} AND (l.record_a = g.id OR l.record_b = g.id)
        UNION ALL
        SELECT r2.id FROM catalogue_record r1
        JOIN catalogue_record r2 ON r2.gtin_key = r1.gtin_key
        WHERE r1.id = g.id
      ) n
    )
    SELECT ${summary ? summaryColumns : recordColumns}, CASE WHEN ${match.where} THEN ${match.rank}::text END AS rank
    FROM grp JOIN catalogue_record r ON r.id = grp.id
    JOIN catalogue_release rel ON rel.id = r.release_id
    ORDER BY r.id`);
  return result.rows;
}

async function linksAmong(db: Db, accountId: string, ids: number[]) {
  const array = `{${ids.join(",")}}`;
  const result = await db.execute<{ record_a: number; record_b: number }>(sql`
    SELECT record_a::int AS record_a, record_b::int AS record_b FROM food_links
    WHERE account_id = ${accountId} AND record_a = ANY(${array}::bigint[]) AND record_b = ANY(${array}::bigint[])
    ORDER BY record_a, record_b`);
  return result.rows;
}

const before = (a: Match, b: Match) =>
  Number(a.rank) > Number(b.rank) || (a.rank === b.rank && a.id < b.id);

/**
 * CA-5 search, paged by group. Matching records are scanned best rank first (ties by id); a group is
 * emitted at its best-placed matching member, so each group appears exactly once across pages.
 */
export async function searchCatalogue(
  db: Db,
  accountId: string,
  query: CatalogueQuery,
  binding: string,
  limit: number,
  cursor?: string,
): Promise<Page<CatalogueGroup>> {
  const match = matchExpression(query);
  let position: Match | null = null;
  if (cursor) {
    const [rank, id] = decodeCursor(binding, cursor, positions.rankId);
    position = { rank, id };
  }
  const groups: CatalogueGroup[] = [];
  for (;;) {
    const after: SQL = position
      ? sql`AND (${match.rank} < ${position.rank}::real OR (${match.rank} = ${position.rank}::real AND r.id > ${position.id}))`
      : sql``;
    const batch = await db.execute<Match>(sql`
      SELECT r.id::int AS id, ${match.rank}::text AS rank FROM catalogue_record r JOIN catalogue_release rel ON rel.id = r.release_id
      WHERE ${match.where} ${after}
      ORDER BY ${match.rank} DESC, r.id LIMIT ${SCAN_BATCH}`);
    if (batch.rows.length === 0) return { items: groups, next_cursor: null, complete: true };
    for (const candidate of batch.rows) {
      const members = await groupOf(db, accountId, candidate.id, match, query.view === "summary");
      const best = members
        .filter((m): m is CatalogueRecord & { rank: string } => m.rank !== null)
        .reduce<Match | null>(
          (acc, m) => (acc === null || before(m, acc) ? { id: m.id, rank: m.rank } : acc),
          null,
        );
      if (best?.id === candidate.id) {
        if (groups.length === limit && position) {
          return {
            items: groups,
            next_cursor: encodeCursor(binding, [position.rank, position.id]),
            complete: false,
          };
        }
        groups.push({
          records: members.map(({ rank, ...record }) => ({ ...record, matched: rank !== null })),
          links: await linksAmong(
            db,
            accountId,
            members.map((m) => m.id),
          ),
        });
      }
      position = candidate;
    }
  }
}

/** One record with this account's group for it (read_catalogue_record). */
export async function readCatalogueRecord(db: Db, accountId: string, id: number) {
  const members = await groupOf(db, accountId, id, {
    where: sql`r.id = ${id}`,
    rank: sql`1::real`,
  });
  const record = members.find((m) => m.id === id);
  if (!record) return null;
  const strip = ({ rank, ...rest }: CatalogueRecord & { rank: string | null }) => rest;
  const ids = members.map((m) => m.id);
  return {
    record: strip(record),
    group: { records: members.map(strip), links: await linksAmong(db, accountId, ids) },
  };
}
