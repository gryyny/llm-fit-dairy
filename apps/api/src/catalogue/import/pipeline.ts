import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Pool, PoolClient } from "pg";
import { from as copyFrom, to as copyTo } from "pg-copy-streams";
import type { PublishedValue } from "../../db/schema.js";
import { gtinKey } from "../gtin.js";

export type Source = "ciqual" | "bls" | "usda" | "off";

/** One source record mapped to catalogue fields as supplied (CA-1, CA-3). */
export interface CatalogueRow {
  sourceId: string;
  name: string | null;
  nameEn: string | null;
  brand: string | null;
  barcode: string | null;
  nutrientBasis: string | null;
  servingBasis: string | null;
  preparation: string | null;
  dataType: string | null;
  nutrients: Record<string, PublishedValue>;
}

export interface Definition {
  code: string;
  name: string | null;
  unit: string | null;
}

export interface ImportResult {
  source: Source;
  release: string;
  archiveSha256: string;
  read: number;
  imported: number;
  alreadyPresent: number;
  rejected: number;
  rejectedReasons: Record<string, number>;
  recordCount: number;
}

const STAGE_COLUMNS =
  "source_id, name, name_en, brand, barcode, nutrient_basis, serving_basis, preparation, data_type, nutrients";

/** COPY text-format field; null is `\N`. */
function copyField(value: string | null): string {
  if (value === null) return "\\N";
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

function copyLine(values: (string | null)[]): string {
  return `${values.map(copyField).join("\t")}\n`;
}

/** Streams lines into `COPY <target> FROM STDIN`, respecting backpressure. */
export async function copyIn(
  client: PoolClient,
  target: string,
  lines: AsyncIterable<string | Buffer> | Iterable<string | Buffer>,
  options = "",
): Promise<void> {
  await pipeline(
    Readable.from(lines),
    client.query(copyFrom(`COPY ${target} FROM STDIN ${options}`)),
  );
}

/**
 * One import of one archive, in one transaction (CA-4). Rows are staged with COPY, de-duplicated,
 * given CA-2 grouping keys and inserted; a source record already stored for the release is counted
 * as already present, never copied twice.
 */
export class ImportRun {
  private read = 0;
  private readonly reasons: Record<string, number> = {};
  private readonly hash = createHash("sha256");

  private constructor(
    readonly client: PoolClient,
    readonly source: Source,
    readonly release: string,
  ) {}

  static async run(
    pool: Pool,
    source: Source,
    release: string,
    body: (run: ImportRun) => Promise<void>,
  ): Promise<ImportResult> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const run = new ImportRun(client, source, release);
      await client.query(
        `CREATE TEMP TABLE stage (seq bigserial, ${STAGE_COLUMNS.split(", ")
          .map((c) => `${c} ${c === "nutrients" ? "jsonb NOT NULL" : "text"}`)
          .join(", ")}, gtin_key text) ON COMMIT DROP`,
      );
      await body(run);
      const result = await run.finish();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Feeds archive bytes into the release's SHA-256. */
  updateHash(chunk: Buffer): void {
    this.hash.update(chunk);
  }

  /** Counts source records that are read but not staged. */
  reject(reason: string, count = 1): void {
    this.read += count;
    this.addReason(reason, count);
  }

  private addReason(reason: string, count: number): void {
    this.reasons[reason] = (this.reasons[reason] ?? 0) + count;
  }

  /** Counts records staged outside `stageRows` (USDA stages with SQL). */
  countRead(count: number): void {
    this.read += count;
  }

  async stageRows(rows: AsyncIterable<CatalogueRow | null> | Iterable<CatalogueRow | null>) {
    const reject = (reason: string) => {
      this.reject(reason);
    };
    const accept = () => {
      this.read++;
    };
    async function* lines() {
      for await (const row of rows) {
        if (!row) continue;
        const nutrients = JSON.stringify(row.nutrients);
        const fields = [
          row.sourceId,
          row.name,
          row.nameEn,
          row.brand,
          row.barcode,
          row.nutrientBasis,
          row.servingBasis,
          row.preparation,
          row.dataType,
        ];
        // PostgreSQL text and jsonb cannot hold NUL; such records are rejected, not altered.
        if (fields.some((f) => f?.includes("\0")) || nutrients.includes("\\u0000")) {
          reject("nul_character");
          continue;
        }
        accept();
        yield copyLine([...fields, nutrients, row.barcode === null ? null : gtinKey(row.barcode)]);
      }
    }
    await copyIn(this.client, `stage (${STAGE_COLUMNS}, gtin_key)`, lines());
  }

  async saveDefinitions(definitions: Iterable<Definition>): Promise<void> {
    await this.client.query(
      "CREATE TEMP TABLE stage_definition (code text, name text, unit text) ON COMMIT DROP",
    );
    await copyIn(
      this.client,
      "stage_definition (code, name, unit)",
      (function* () {
        for (const d of definitions) yield copyLine([d.code, d.name, d.unit]);
      })(),
    );
  }

  private async finish(): Promise<ImportResult> {
    const { client } = this;
    const sha = this.hash.digest("hex");

    const duplicates = await client.query(
      `DELETE FROM stage s USING stage f WHERE s.source_id = f.source_id AND s.seq > f.seq`,
    );
    if (duplicates.rowCount) this.addReason("duplicate_source_id", duplicates.rowCount);

    const existing = await client.query<{ id: string; archive_sha256: string }>(
      "SELECT id, archive_sha256 FROM catalogue_release WHERE source = $1 AND release = $2 FOR UPDATE",
      [this.source, this.release],
    );
    let releaseId: string;
    const found = existing.rows[0];
    if (found) {
      if (found.archive_sha256 !== sha) {
        throw new Error(
          `${this.source} release ${this.release} was imported from a different archive (SHA-256 ${found.archive_sha256}); refusing to mix archives`,
        );
      }
      releaseId = found.id;
    } else {
      const created = await client.query<{ id: string }>(
        `INSERT INTO catalogue_release (source, release, archive_sha256, read_count, record_count, rejected_count, rejected_reasons)
         VALUES ($1, $2, $3, 0, 0, 0, '{}') RETURNING id`,
        [this.source, this.release, sha],
      );
      releaseId = created.rows[0]?.id ?? "";
    }

    const staged = await client.query<{ n: string }>("SELECT count(*) AS n FROM stage");
    const inserted = await client.query(
      `INSERT INTO catalogue_record (release_id, ${STAGE_COLUMNS}, gtin_key)
       SELECT $1, ${STAGE_COLUMNS}, gtin_key FROM stage ORDER BY seq
       ON CONFLICT (release_id, source_id) DO NOTHING`,
      [releaseId],
    );
    const definitions = await client.query<{ t: string | null }>(
      "SELECT to_regclass('pg_temp.stage_definition')::text AS t",
    );
    if (definitions.rows[0]?.t) {
      await client.query(
        `INSERT INTO nutrient_definition (release_id, code, name, unit)
         SELECT DISTINCT ON (code) $1, code, name, unit FROM stage_definition ORDER BY code
         ON CONFLICT DO NOTHING`,
        [releaseId],
      );
    }
    const rejected = Object.values(this.reasons).reduce((a, b) => a + b, 0);
    const records = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM catalogue_record WHERE release_id = $1",
      [releaseId],
    );
    const recordCount = Number(records.rows[0]?.n);
    await client.query(
      `UPDATE catalogue_release SET read_count = $2, record_count = $3, rejected_count = $4,
         rejected_reasons = $5, imported_at = now() WHERE id = $1`,
      [releaseId, this.read, recordCount, rejected, JSON.stringify(this.reasons)],
    );
    const imported = inserted.rowCount ?? 0;
    return {
      source: this.source,
      release: this.release,
      archiveSha256: sha,
      read: this.read,
      imported,
      alreadyPresent: Number(staged.rows[0]?.n) - imported,
      rejected,
      rejectedReasons: this.reasons,
      recordCount,
    };
  }

  /**
   * For rows staged with SQL (USDA): streams their distinct barcodes out, applies the same CA-2
   * function, and streams the eligible keys back. Row-based importers get keys in `stageRows`.
   */
  async assignGtinKeys(): Promise<void> {
    const { client } = this;
    await client.query("CREATE TEMP TABLE stage_gtin (barcode text, gtin_key text) ON COMMIT DROP");
    const reader = client.query(
      copyTo("COPY (SELECT DISTINCT barcode FROM stage WHERE barcode IS NOT NULL) TO STDOUT"),
    );
    // Only digit strings can be eligible, so COPY's text escaping never affects a kept barcode.
    // Eligible keys are collected first because COPY OUT must finish before COPY IN starts.
    const keys: string[] = [];
    for await (const barcode of createInterface({ input: reader, crlfDelay: Infinity })) {
      const key = gtinKey(barcode);
      if (key) keys.push(copyLine([barcode, key]));
    }
    await copyIn(client, "stage_gtin (barcode, gtin_key)", keys);
    await client.query(
      "UPDATE stage s SET gtin_key = g.gtin_key FROM stage_gtin g WHERE g.barcode = s.barcode",
    );
  }
}
