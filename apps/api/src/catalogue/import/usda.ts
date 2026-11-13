import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import type { ImportRun } from "./pipeline.js";
import { copyIn } from "./pipeline.js";
import { openZip, type ZipArchive } from "./zip.js";

/** Parses the quoted CSV header line FoodData Central writes, e.g. `"fdc_id","data_type"`. */
function headerColumns(line: string): string[] {
  return line
    .replace(/\r$/, "")
    .split(",")
    .map((c) => c.replace(/^"|"$/g, ""))
    .map((c) => {
      if (!/^[a-z_][a-z0-9_]*$/.test(c)) throw new Error(`Unexpected USDA column name ${c}`);
      return c;
    });
}

/**
 * Copies one CSV entry into a temp table named after it, with text columns taken from its header,
 * using PostgreSQL's own CSV parser so quoting and embedded newlines follow the file.
 */
async function stageCsv(run: ImportRun, zip: ZipArchive, file: string): Promise<string[]> {
  const name = zip.names.find((n) => n === file || n.endsWith(`/${file}`));
  if (!name) throw new Error(`USDA archive has no ${file}`);
  const table = `usda_${file.replace(/\.csv$/, "")}`;
  const stream: Readable = await zip.open(name);
  const iterator = (stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  let head = Buffer.alloc(0);
  let newline = -1;
  while (newline < 0) {
    const next = await iterator.next();
    if (next.done) throw new Error(`${file} has no header line`);
    head = Buffer.concat([head, next.value]);
    newline = head.indexOf(10);
  }
  const columns = headerColumns(head.subarray(0, newline).toString("utf8"));
  await run.client.query(
    `CREATE TEMP TABLE ${table} (${columns.map((c) => `${c} text`).join(", ")}) ON COMMIT DROP`,
  );
  async function* chunks() {
    yield head;
    for (let next = await iterator.next(); !next.done; next = await iterator.next())
      yield next.value;
  }
  await copyIn(
    run.client,
    `${table} (${columns.join(", ")})`,
    chunks(),
    "WITH (FORMAT csv, HEADER true)",
  );
  return columns;
}

async function count(run: ImportRun, query: string): Promise<number> {
  const result = await run.client.query<{ n: string }>(query);
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * USDA FoodData Central full CSV download (CA-7). Food rows are joined with their nutrients,
 * branded details and portions in SQL; nutrient amounts keep their published text and unit,
 * keyed by FoodData Central's nutrient id. Brand and barcode come from `branded_food.csv`, or for
 * market acquisitions from `market_acquisition.csv` (`brand_description`, `upc_code`), as published.
 * Every row is kept with its raw `data_type`, so
 * laboratory sample and acquisition records stay distinguishable from foods.
 */
export async function importUsda(run: ImportRun, path: string): Promise<void> {
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) run.updateHash(chunk);
  const zip = await openZip(path);
  try {
    for (const file of [
      "food.csv",
      "nutrient.csv",
      "food_nutrient.csv",
      "branded_food.csv",
      "food_portion.csv",
      "measure_unit.csv",
      "market_acquisition.csv",
    ]) {
      await stageCsv(run, zip, file);
    }
  } finally {
    zip.close();
  }
  const { client } = run;

  // Every food row is kept with its raw data_type, including laboratory sample and acquisition rows.
  const missingId = await count(
    run,
    "SELECT count(*) AS n FROM usda_food WHERE coalesce(fdc_id, '') !~ '^[0-9]+$'",
  );
  if (missingId > 0) run.reject("missing_source_id", missingId);

  // A record keeps one value per nutrient; refuse to drop a conflicting published value silently.
  const conflicts = await count(
    run,
    `SELECT count(*) AS n FROM (SELECT 1 FROM usda_food_nutrient WHERE amount <> ''
       GROUP BY fdc_id, nutrient_id HAVING count(DISTINCT amount) > 1) c`,
  );
  if (conflicts > 0) {
    throw new Error(
      `${conflicts} food/nutrient pairs have conflicting amounts in food_nutrient.csv; inspect before importing`,
    );
  }

  await client.query(`
    INSERT INTO stage (source_id, name, name_en, brand, barcode, nutrient_basis, serving_basis, preparation, data_type, nutrients)
    SELECT f.fdc_id,
           nullif(f.description, ''),
           NULL,
           coalesce(
             nullif(concat_ws(' / ', nullif(b.brand_owner, ''), nullif(b.brand_name, ''), nullif(b.subbrand_name, '')), ''),
             nullif(ma.brand_description, '')),
           coalesce(nullif(b.gtin_upc, ''), nullif(ma.upc_code, '')),
           CASE WHEN f.data_type = 'branded_food' THEN '100 g or 100 ml' ELSE '100 g' END,
           CASE WHEN f.data_type = 'branded_food'
                THEN nullif(concat_ws(' ', nullif(b.serving_size, ''), nullif(b.serving_size_unit, ''),
                     CASE WHEN nullif(b.household_serving_fulltext, '') IS NOT NULL THEN '(' || b.household_serving_fulltext || ')' END), '')
                ELSE p.portions END,
           nullif(b.preparation_state_code, ''),
           nullif(f.data_type, ''),
           coalesce(n.nutrients, '{}'::jsonb)
    FROM usda_food f
    LEFT JOIN usda_branded_food b ON b.fdc_id = f.fdc_id
    LEFT JOIN usda_market_acquisition ma ON ma.fdc_id = f.fdc_id
    LEFT JOIN (
      SELECT fn.fdc_id,
             jsonb_object_agg(fn.nutrient_id, jsonb_build_object('value', fn.amount, 'unit', nullif(nd.unit_name, ''))) AS nutrients
      FROM usda_food_nutrient fn LEFT JOIN usda_nutrient nd ON nd.id = fn.nutrient_id
      WHERE fn.amount <> ''
      GROUP BY fn.fdc_id
    ) n ON n.fdc_id = f.fdc_id
    LEFT JOIN (
      SELECT fp.fdc_id,
             string_agg(concat_ws(' ', nullif(fp.amount, ''), nullif(nullif(mu.name, ''), 'undetermined'),
                                  nullif(fp.portion_description, ''), nullif(fp.modifier, ''))
                        || ' = ' || fp.gram_weight || ' g', '; '
                        ORDER BY nullif(fp.seq_num, '')::numeric NULLS LAST, fp.id) AS portions
      FROM usda_food_portion fp LEFT JOIN usda_measure_unit mu ON mu.id = fp.measure_unit_id
      WHERE fp.gram_weight <> ''
      GROUP BY fp.fdc_id
    ) p ON p.fdc_id = f.fdc_id
    WHERE f.fdc_id ~ '^[0-9]+$'
    ORDER BY f.fdc_id::bigint`);
  run.countRead(await count(run, "SELECT count(*) AS n FROM stage"));
  await run.assignGtinKeys();

  await client.query(
    "CREATE TEMP TABLE stage_definition ON COMMIT DROP AS SELECT id AS code, name, nullif(unit_name, '') AS unit FROM usda_nutrient",
  );
}
