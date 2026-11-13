import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { importCatalogue } from "../src/catalogue/import/index.js";
import type { Source } from "../src/catalogue/import/pipeline.js";
import { readCatalogueRecord, searchCatalogue } from "../src/catalogue/search.js";
import { cursorBinding, encodeCursor } from "../src/paging.js";
import { createPool } from "./db.js";

const fixture = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const pool = createPool();
const db: Db = createDb(pool);
const run = Date.now().toString(36);
const releaseOf: Record<Source, string> = {
  ciqual: `ciqual-${run}`,
  bls: `bls-${run}`,
  usda: `usda-${run}`,
  off: `off-${run}`,
};
const paths: Record<Source, string> = {
  ciqual: fixture("ciqual"),
  bls: fixture("bls.zip"),
  usda: fixture("usda.zip"),
  off: fixture("off.jsonl.gz"),
};
const doImport = (source: Source) =>
  importCatalogue(pool, source, paths[source], releaseOf[source]);

async function records(source: Source) {
  const result = await pool.query<{
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
    nutrients: Record<string, { value: string; unit: string | null }>;
  }>(
    `SELECT r.* FROM catalogue_record r JOIN catalogue_release rel ON rel.id = r.release_id
     WHERE rel.source = $1 AND rel.release = $2 ORDER BY r.source_id`,
    [source, releaseOf[source]],
  );
  return new Map(result.rows.map((r) => [r.source_id, r]));
}

async function definitions(source: Source) {
  const result = await pool.query<{ code: string; name: string | null; unit: string | null }>(
    `SELECT d.code, d.name, d.unit FROM nutrient_definition d JOIN catalogue_release rel ON rel.id = d.release_id
     WHERE rel.source = $1 AND rel.release = $2 ORDER BY d.code`,
    [source, releaseOf[source]],
  );
  return result.rows;
}

afterAll(() => pool.end());

describe("catalogue import (T5 with fixtures)", () => {
  it("imports Ciqual XML with published values, units and missing values left out", async () => {
    const result = await doImport("ciqual");
    expect(result).toMatchObject({
      read: 2,
      imported: 2,
      alreadyPresent: 0,
      rejected: 0,
      recordCount: 2,
    });
    const rows = await records("ciqual");
    expect(rows.get("99001")).toMatchObject({
      name: "Flocons d'avoine test",
      name_en: "Test oat flakes",
      nutrient_basis: "100 g edible portion",
      barcode: null,
      nutrients: {
        "328": { value: "367", unit: "kcal/100g" },
        "400": { value: "9,7", unit: "g/100g" },
        "10004": { value: "< 0,01", unit: "g/100g" },
      },
    });
    expect(rows.get("99002")?.nutrients).toEqual({ "400": { value: "traces", unit: "g/100g" } });
    expect(await definitions("ciqual")).toEqual([
      { code: "10004", name: "Salt (g/100g)", unit: "g/100g" },
      { code: "328", name: "Energy, Regulation EU No 1169/2011 (kcal/100g)", unit: "kcal/100g" },
      { code: "400", name: "Water (g/100g)", unit: "g/100g" },
    ]);
  });

  it("imports BLS XLSX inside its ZIP, keeping published text and the entered numeric value", async () => {
    const result = await doImport("bls");
    expect(result).toMatchObject({
      read: 3,
      imported: 2,
      rejected: 1,
      rejectedReasons: { missing_source_id: 1 },
    });
    const rows = await records("bls");
    expect(rows.get("X100001")).toMatchObject({
      name: "Testhafer ganzes Korn, roh",
      name_en: "Test oat whole grain, raw",
      nutrient_basis: "100 g",
      nutrients: {
        ENERCC: { value: "343", unit: "kcal/100g" },
        FIBT: { value: "9.3", unit: "g/100g" },
        TOCPHG: { value: "<LOQ", unit: "mg/100g" },
      },
    });
    expect(rows.get("X100002")).toMatchObject({
      name_en: "Test oat flakes",
      nutrients: {
        ENERCC: { value: "0.015", unit: "kcal/100g" },
        FIBT: { value: "-", unit: "g/100g" },
      },
    });
    expect(rows.get("X100002")?.nutrients).not.toHaveProperty("TOCPHG");
    expect((await definitions("bls")).map((d) => d.code)).toEqual(["ENERCC", "FIBT", "TOCPHG"]);
  });

  it("imports every USDA row with its raw data type, nutrients by FDC id, branded and portion bases", async () => {
    const result = await doImport("usda");
    expect(result).toEqual(
      expect.objectContaining({
        read: 7,
        imported: 6,
        rejected: 1,
        rejectedReasons: { missing_source_id: 1 },
      }),
    );
    const rows = await records("usda");
    expect([...rows.entries()].map(([id, r]) => [id, r.data_type])).toEqual([
      ["900001", "branded_food"],
      ["900002", "sr_legacy_food"],
      ["900003", "sub_sample_food"],
      ["900004", "market_acquistion"],
      ["900005", "branded_food"],
      ["900006", "experimental_food"],
    ]);
    // Market acquisitions keep the brand and UPC published in market_acquisition.csv.
    expect(rows.get("900004")).toMatchObject({
      data_type: "market_acquistion",
      brand: "Acquired Testbrand",
      barcode: "036000291452",
      gtin_key: "00036000291452",
    });
    expect(rows.get("900003")).toMatchObject({
      name: "Test oats sample",
      nutrients: { "1008": { value: "1", unit: "KCAL" } },
    });
    expect(rows.get("900006")).toMatchObject({
      name: "Test oats, experimental cultivar",
      nutrient_basis: "100 g",
      nutrients: { "1003": { value: "14.1", unit: "G" } },
    });
    expect(rows.get("900001")).toMatchObject({
      name: "TEST OATS, ROLLED",
      brand: "Test Mills Inc. / TESTBRAND",
      barcode: "00036000291452",
      gtin_key: "00036000291452",
      nutrient_basis: "100 g or 100 ml",
      serving_basis: "40.0 g (1/2 cup (40 g))",
      nutrients: {
        "1008": { value: "379.0", unit: "KCAL" },
        "1003": { value: "13.15", unit: "G" },
      },
    });
    expect(rows.get("900002")).toMatchObject({
      nutrient_basis: "100 g",
      serving_basis: "1.0 cup = 81.0 g; 1.0 serving = 40.0 g",
      nutrients: { "1008": { value: "389", unit: "KCAL" } },
    });
    expect(rows.get("900005")).toMatchObject({
      name: 'TEST "QUOTED" BAR, WITH\nNEWLINE',
      barcode: "0-41190-06938-5",
      gtin_key: null,
      preparation: "READY_TO_EAT",
      nutrients: {},
    });
    expect(await definitions("usda")).toEqual([
      { code: "1003", name: "Protein", unit: "G" },
      { code: "1008", name: "Energy", unit: "KCAL" },
    ]);
  });

  it("imports Open Food Facts JSONL from both nutrient schemas and counts every rejected line", async () => {
    const result = await doImport("off");
    expect(result).toMatchObject({
      read: 8,
      imported: 4,
      rejected: 4,
      rejectedReasons: {
        invalid_json: 1,
        missing_source_id: 1,
        nul_character: 1,
        duplicate_source_id: 1,
      },
    });
    const rows = await records("off");
    expect(rows.get("036000291452")).toMatchObject({
      name: "Test Rolled Oats",
      brand: "Testbrand",
      gtin_key: "00036000291452",
      serving_basis: "40 g",
      nutrients: {
        "energy-kcal_100g": { value: "375", unit: null },
        proteins_100g: { value: "12.5", unit: null },
        proteins_unit: { value: "g", unit: null },
      },
    });
    expect(rows.get("4006381333931")).toMatchObject({
      name: "Testflocken",
      name_en: "Test flakes",
      nutrients: {
        "packaging:as_sold:100g:salt": { value: "<0.5", unit: "g" },
        "packaging:as_sold:100g:energy-kcal": { value: "361", unit: "kcal" },
        "estimate:as_sold:100g:fruits-vegetables-nuts": { value: "0", unit: "%" },
      },
    });
    expect(rows.get("2012345000001")).toMatchObject({ barcode: "2012345000001", gtin_key: null });
    expect(rows.get("5000000000001")).toMatchObject({ name: null, nutrients: {} });
  });

  it("re-importing the same archive adds no duplicate records", async () => {
    for (const source of ["ciqual", "bls", "usda", "off"] as const) {
      const before = (await records(source)).size;
      const again = await doImport(source);
      expect(again.imported).toBe(0);
      expect(again.alreadyPresent).toBe(before);
      expect((await records(source)).size).toBe(before);
    }
  });

  it("counts a duplicated Ciqual food code as rejected instead of overwriting the first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ciqual-"));
    for (const name of ["const_2099_01_01.xml", "compo_2099_01_01.xml"]) {
      await writeFile(join(dir, name), await readFile(join(paths.ciqual, name)));
    }
    const alim = await readFile(join(paths.ciqual, "alim_2099_01_01.xml"), "utf8");
    const duplicate =
      "<ALIM><alim_code> 99001 </alim_code><alim_nom_fr> Doublon </alim_nom_fr></ALIM>";
    await writeFile(
      join(dir, "alim_2099_01_01.xml"),
      alim.replace("</TABLE>", `${duplicate}</TABLE>`),
    );
    const result = await importCatalogue(pool, "ciqual", dir, `dup-${run}`);
    expect(result).toMatchObject({
      read: 3,
      imported: 2,
      rejected: 1,
      rejectedReasons: { duplicate_source_id: 1 },
    });
  });

  it("refuses to mix a different archive into an imported release and leaves it unchanged", async () => {
    const label = `mixed-${run}`;
    await importCatalogue(pool, "off", paths.off, label);
    const dir = await mkdtemp(join(tmpdir(), "off-"));
    const changed = join(dir, "off.jsonl.gz");
    await writeFile(changed, gzipSync('{"code":"5000000000018","product_name":"Other export"}\n'));
    await expect(importCatalogue(pool, "off", changed, label)).rejects.toThrow(/different archive/);
    const count = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM catalogue_record r JOIN catalogue_release rel ON rel.id = r.release_id
       WHERE rel.source = 'off' AND rel.release = $1`,
      [label],
    );
    expect(Number(count.rows[0]?.n)).toBe(4);
  });
});

describe("catalogue search and GTIN grouping (CA-5, T5 without links)", () => {
  const account = randomUUID();
  const binding = cursorBinding(account, "search");
  beforeAll(async () => {
    // Imports from the first describe block are reused; make sure they exist when run alone.
    for (const source of ["usda", "off"] as const) await doImport(source);
  });

  it("groups valid leading-zero GTIN equivalents across sources, including a USDA acquisition, keeping each value", async () => {
    const page = await searchCatalogue(
      db,
      account,
      { gtin: "36000291452".padStart(13, "0") },
      binding,
      20,
    );
    const group = page.items.find((g) => g.records.some((r) => r.release === releaseOf.usda));
    expect(group).toBeDefined();
    const mine =
      group?.records.filter((r) => [releaseOf.usda, releaseOf.off].includes(r.release)) ?? [];
    expect(
      mine.map((r) => [r.source, r.barcode, r.nutrients?.["1003"] ?? r.nutrients?.proteins_100g]),
    ).toEqual([
      ["usda", "00036000291452", { value: "13.15", unit: "G", name: "Protein" }],
      ["usda", "036000291452", undefined],
      ["off", "036000291452", { value: "12.5", unit: null, name: null }],
    ]);
    expect(mine.map((r) => [r.data_type, r.brand])).toEqual([
      ["branded_food", "Test Mills Inc. / TESTBRAND"],
      ["market_acquistion", "Acquired Testbrand"],
      [null, "Testbrand"],
    ]);
    // An exact lookup by the acquisition's own published UPC finds the same group.
    const byAcquisitionUpc = await searchCatalogue(
      db,
      account,
      { gtin: "036000291452" },
      binding,
      20,
    );
    const sameGroup = byAcquisitionUpc.items.find((g) =>
      g.records.some((r) => r.release === releaseOf.usda),
    );
    expect(sameGroup?.records.map((r) => r.id)).toEqual(group?.records.map((r) => r.id));
  });

  it("filters matching candidates without truncating linked groups and omits values in summary", async () => {
    await doImport("usda");
    await doImport("off");
    const result = await searchCatalogue(
      db,
      account,
      { gtin: "036000291452", source: "off", view: "summary" },
      binding,
      20,
    );
    const group = result.items.find((g) => g.records.some((r) => r.release === releaseOf.off));
    expect(group).toBeDefined();
    expect(group?.records.some((r) => r.source === "usda" && !r.matched)).toBe(true);
    expect(group?.records.filter((r) => r.matched).every((r) => r.source === "off")).toBe(true);
    for (const record of group?.records ?? []) expect(record).not.toHaveProperty("nutrients");
    const chosen = group?.records.find((r) => r.source === "usda");
    if (!chosen) throw new Error("fixture record missing");
    const detail = await readCatalogueRecord(db, account, chosen.id);
    expect(detail?.record.nutrients).toBeDefined();
    expect(detail?.group.records.map((r) => r.id)).toEqual(group?.records.map((r) => r.id));
    const filtered = await searchCatalogue(
      db,
      account,
      { q: "Test", source: "usda", data_type: "sr_legacy_food", view: "summary" },
      binding,
      20,
    );
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(
      filtered.items
        .flatMap((g) => g.records)
        .filter((r) => r.matched)
        .every((r) => r.source === "usda" && r.data_type === "sr_legacy_food"),
    ).toBe(true);
  });

  it("returns each value with its release's nutrient definition name", async () => {
    await doImport("ciqual");
    const page = await searchCatalogue(db, account, { q: "test oat flakes" }, binding, 20);
    const ciqual = page.items.flatMap((g) => g.records).find((r) => r.source === "ciqual");
    expect(ciqual?.nutrients?.["400"]).toEqual({
      value: "9,7",
      unit: "g/100g",
      name: "Water (g/100g)",
    });
    expect(ciqual?.nutrients?.["328"]?.name).toBe("Energy, Regulation EU No 1169/2011 (kcal/100g)");
    expect(ciqual?.data_type).toBeNull();
  });

  it("never groups a restricted or invalid code, even when looked up exactly", async () => {
    const rcn = await searchCatalogue(db, account, { gtin: "2012345000001" }, binding, 20);
    for (const group of rcn.items) expect(group.records).toHaveLength(1);
    const invalid = await searchCatalogue(db, account, { gtin: "0-41190-06938-5" }, binding, 20);
    expect(invalid.items.length).toBeGreaterThan(0);
    for (const group of invalid.items) expect(group.records).toHaveLength(1);
  });

  it("finds records by name prefix and returns every group exactly once across pages", async () => {
    const seen: number[][] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await searchCatalogue(db, account, { q: "test oat" }, binding, 1, cursor);
      pages++;
      seen.push(...page.items.map((g) => g.records.map((r) => r.id)));
      if (page.complete) {
        expect(page.next_cursor).toBeNull();
        break;
      }
      expect(page.next_cursor).not.toBeNull();
      cursor = page.next_cursor ?? undefined;
    }
    const all = await searchCatalogue(db, account, { q: "test oat" }, binding, 20);
    expect(all.complete).toBe(true);
    expect(seen).toEqual(all.items.map((g) => g.records.map((r) => r.id)));
    expect(new Set(seen.flat()).size).toBe(seen.flat().length);
    expect(pages).toBeGreaterThan(2);
  });

  it("rejects a cursor used for a different query", async () => {
    const page = await searchCatalogue(db, account, { q: "test" }, binding, 1);
    expect(page.next_cursor).not.toBeNull();
    const other = cursorBinding(randomUUID(), "search");
    await expect(
      searchCatalogue(db, account, { q: "test" }, other, 1, page.next_cursor ?? ""),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses cursor ranks outside PostgreSQL's real range instead of failing in SQL", async () => {
    const q = { q: "test" };
    for (const rank of ["1e999999", "1e-999999", "4e38"]) {
      await expect(
        searchCatalogue(db, account, q, binding, 1, encodeCursor(binding, [rank, 1])),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(
      searchCatalogue(db, account, q, binding, 1, encodeCursor(binding, ["0.5", 1])),
    ).resolves.toBeDefined();
  });

  it("reads one record with its group", async () => {
    const page = await searchCatalogue(db, account, { gtin: "036000291452" }, binding, 20);
    const id = page.items[0]?.records[0]?.id ?? 0;
    const read = await readCatalogueRecord(db, account, id);
    expect(read?.record.id).toBe(id);
    expect(read?.group.records.length).toBeGreaterThan(1);
    expect(await readCatalogueRecord(db, account, 2 ** 31 - 1)).toBeNull();
  });
});
