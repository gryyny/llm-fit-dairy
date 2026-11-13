import { createReadStream } from "node:fs";
import type { CatalogueRow, Definition, ImportRun } from "./pipeline.js";
import { xlsxRows } from "./xlsx.js";
import { openZip, readAll } from "./zip.js";

/** Nutrient value columns are headed "<code> <name> [<unit>]", e.g. "ENERCC Energie (Kilokalorien) [kcal/100g]". */
const VALUE_HEADER = /^(\S+) (.+) \[([^\]]+)\]$/;

/**
 * BLS 4.0 (CA-7): the publisher's ZIP holds an XLSX workbook whose first sheet has one row per food:
 * BLS code, German and English names, then for each nutrient a value, data-origin and reference
 * column. Values and units are kept as published; origin and reference columns are not stored.
 */
export async function importBls(run: ImportRun, path: string): Promise<void> {
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) run.updateHash(chunk);
  const zip = await openZip(path);
  let workbook: Buffer;
  try {
    const name = zip.names.find((n) => /Daten.*\.xlsx$/i.test(n));
    if (!name) throw new Error("BLS archive has no data workbook (*Daten*.xlsx)");
    workbook = await readAll(await zip.open(name));
  } finally {
    zip.close();
  }

  const rows = xlsxRows(workbook);
  const first = await rows.next();
  const header = first.done ? undefined : first.value;
  if (header?.A !== "BLS Code") throw new Error("Unexpected BLS header row");
  const columns: { column: string; code: string; unit: string }[] = [];
  const definitions: Definition[] = [];
  for (const [column, title] of Object.entries(header)) {
    const match = VALUE_HEADER.exec(title);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    columns.push({ column, code: match[1], unit: match[3] });
    definitions.push({ code: match[1], name: match[2], unit: match[3] });
  }
  await run.saveDefinitions(definitions);

  async function* records(): AsyncGenerator<CatalogueRow | null> {
    for await (const row of rows) {
      if (Object.keys(row).length === 0) continue;
      const code = row.A;
      if (!code) {
        run.reject("missing_source_id");
        yield null;
        continue;
      }
      const nutrients: CatalogueRow["nutrients"] = {};
      for (const { column, code: nutrient, unit } of columns) {
        const value = row[column];
        if (value !== undefined) nutrients[nutrient] = { value, unit };
      }
      yield {
        sourceId: code,
        name: row.B ?? null,
        nameEn: row.C ?? null,
        brand: null,
        barcode: null,
        nutrientBasis: "100 g",
        servingBasis: null,
        preparation: null,
        dataType: null,
        nutrients,
      };
    }
  }
  await run.stageRows(records());
}
