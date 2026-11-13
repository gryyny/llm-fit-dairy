import type { Pool } from "pg";
import { importBls } from "./bls.js";
import { importCiqual } from "./ciqual.js";
import { importOff } from "./off.js";
import { ImportRun, type ImportResult, type Source } from "./pipeline.js";
import { importUsda } from "./usda.js";

const importers: Record<Source, (run: ImportRun, path: string) => Promise<void>> = {
  ciqual: importCiqual,
  bls: importBls,
  usda: importUsda,
  off: importOff,
};

export const sources = Object.keys(importers) as Source[];

export function importCatalogue(
  pool: Pool,
  source: Source,
  path: string,
  release: string,
): Promise<ImportResult> {
  return ImportRun.run(pool, source, release, (run) => importers[source](run, path));
}
