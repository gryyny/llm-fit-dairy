import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PublishedValue } from "../../db/schema.js";
import type { CatalogueRow, ImportRun } from "./pipeline.js";
import { xmlRecords } from "./xml.js";

/** Reads a file once, feeding the release hash and yielding its chunks. */
async function* hashedChunks(run: ImportRun, path: string): AsyncGenerator<Buffer> {
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    run.updateHash(chunk);
    yield chunk;
  }
}

async function findFile(dir: string, prefix: string): Promise<string> {
  const matches = (await readdir(dir)).filter(
    (f) => f.startsWith(`${prefix}_`) && f.endsWith(".xml"),
  );
  const [file, ...others] = matches;
  if (!file || others.length) throw new Error(`Expected exactly one ${prefix}_*.xml in ${dir}`);
  return join(dir, file);
}

/** Unit as published at the end of a constituent name, e.g. "Water (g/100g)" → "g/100g". */
const unitOf = (name: string | undefined) => /\(([^()]+)\)\s*$/.exec(name ?? "")?.[1] ?? null;

/**
 * Ciqual 2025 XML (CA-7): a folder holding the release's alim_*, const_* and compo_* files.
 * One record per food; composition values keep their published text, e.g. "59,7", "< 0,5", "traces".
 */
export async function importCiqual(run: ImportRun, dir: string): Promise<void> {
  const [constFile, alimFile, compoFile] = await Promise.all(
    ["const", "alim", "compo"].map((p) => findFile(dir, p)),
  );
  if (!constFile || !alimFile || !compoFile) throw new Error("Ciqual files not found");

  const units = new Map<string, string | null>();
  const definitions = [];
  for await (const c of xmlRecords(hashedChunks(run, constFile), "CONST")) {
    if (!c.const_code) continue;
    const unit = unitOf(c.const_nom_eng ?? c.const_nom_fr);
    units.set(c.const_code, unit);
    definitions.push({ code: c.const_code, name: c.const_nom_eng ?? c.const_nom_fr ?? null, unit });
  }
  await run.saveDefinitions(definitions);

  const foods = new Map<string, CatalogueRow>();
  for await (const a of xmlRecords(hashedChunks(run, alimFile), "ALIM")) {
    const code = a.alim_code;
    if (!code) {
      run.reject("missing_source_id");
      continue;
    }
    if (foods.has(code)) {
      run.reject("duplicate_source_id");
      continue;
    }
    foods.set(code, {
      sourceId: code,
      name: a.alim_nom_fr ?? null,
      nameEn: a.alim_nom_eng ?? null,
      brand: null,
      barcode: null,
      nutrientBasis: "100 g edible portion",
      servingBasis: null,
      preparation: null,
      dataType: null,
      nutrients: {},
    });
  }

  for await (const c of xmlRecords(hashedChunks(run, compoFile), "COMPO")) {
    const food = c.alim_code === undefined ? undefined : foods.get(c.alim_code);
    if (!food || !c.const_code) {
      throw new Error(
        `Composition row refers to an unknown food or constituent: ${JSON.stringify(c)}`,
      );
    }
    if (c.teneur === undefined) continue;
    const value: PublishedValue = { value: c.teneur, unit: units.get(c.const_code) ?? null };
    food.nutrients[c.const_code] = value;
  }
  await run.stageRows(foods.values());
}
