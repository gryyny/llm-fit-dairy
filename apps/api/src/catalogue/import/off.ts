import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { createGunzip } from "node:zlib";
import type { CatalogueRow, Definition, ImportRun } from "./pipeline.js";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const scalarText = (v: unknown) =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : null;

/**
 * Nutrients as published. Products in the current schema carry `nutrition.input_sets`, each with a
 * source (packaging, manufacturer, estimate…), preparation and basis; their values are keyed
 * `<source>:<preparation>:<per>:<nutrient>` with the set's unit and any modifier ("<", "~") kept
 * in front of the value. Products in the legacy schema carry a flat `nutriments` object whose keys
 * already state their basis (`proteins_100g`, `proteins_serving`, `proteins_unit`); those are kept
 * as-is with no separate unit.
 */
function nutrientsOf(product: Record<string, unknown>): CatalogueRow["nutrients"] {
  const nutrients: CatalogueRow["nutrients"] = {};
  const nutrition = product.nutrition;
  if (isRecord(nutrition) && Array.isArray(nutrition.input_sets)) {
    for (const set of nutrition.input_sets) {
      if (!isRecord(set) || !isRecord(set.nutrients)) continue;
      const prefix = [set.source, set.preparation, set.per]
        .map((p) => scalarText(p) ?? "")
        .join(":");
      for (const [name, entry] of Object.entries(set.nutrients)) {
        if (!isRecord(entry)) continue;
        const value = scalarText(entry.value_string) ?? scalarText(entry.value);
        if (value === null) continue;
        nutrients[`${prefix}:${name}`] = {
          value: `${scalarText(entry.modifier) ?? ""}${value}`,
          unit: text(entry.unit),
        };
      }
    }
  }
  if (isRecord(product.nutriments)) {
    for (const [key, raw] of Object.entries(product.nutriments)) {
      const value = scalarText(raw);
      if (value !== null) nutrients[key] = { value, unit: null };
    }
  }
  return nutrients;
}

/** Open Food Facts JSONL export, gzip-compressed (CA-7), streamed one product per line. */
export async function importOff(run: ImportRun, path: string): Promise<void> {
  const compressed = createReadStream(path);
  const tap = new PassThrough();
  tap.on("data", (chunk: Buffer) => {
    run.updateHash(chunk);
  });
  const lines = createInterface({
    input: compressed.pipe(tap).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  const codes = new Set<string>();

  async function* records(): AsyncGenerator<CatalogueRow | null> {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      let product: unknown;
      try {
        product = JSON.parse(line);
      } catch {
        run.reject("invalid_json");
        continue;
      }
      if (!isRecord(product)) {
        run.reject("invalid_json");
        continue;
      }
      const code = text(product.code);
      if (!code) {
        run.reject("missing_source_id");
        continue;
      }
      const nutrients = nutrientsOf(product);
      for (const key of Object.keys(nutrients)) codes.add(key);
      const name = text(product.product_name);
      const nameEn = text(product.product_name_en);
      yield {
        sourceId: code,
        name,
        nameEn: nameEn === name ? null : nameEn,
        brand: text(product.brands),
        barcode: code,
        nutrientBasis: null,
        servingBasis: text(product.serving_size),
        preparation: null,
        dataType: null,
        nutrients,
      };
    }
  }
  await run.stageRows(records());
  const definitions: Definition[] = [...codes].map((code) => ({ code, name: null, unit: null }));
  await run.saveDefinitions(definitions);
}
