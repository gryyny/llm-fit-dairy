import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cursorBinding, encodeCursor } from "../src/paging.js";
import { call, startApp, type TestApp } from "./app.js";
import {
  connect,
  diary,
  estimate,
  join,
  ownProfile,
  setupProfiles,
  type Setup,
} from "./diary-helpers.js";

interface Entry {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  nutrients: Record<string, number>;
  source: string;
  note: string;
  catalogue_record_id: number | null;
  product_id: string | null;
  recipe_id: string | null;
  label: { basis_amount: number; basis_unit: string; nutrients: Record<string, number> } | null;
  version: number;
}
interface Meal {
  id: string;
  diary_date: string;
  label: string | null;
  note: string | null;
  version: number;
  entries: Entry[];
}
interface Day {
  date: string;
  target_kind: string;
  target_kind_selected: boolean;
  target: { id: string; kind: string; effective_from: string } | null;
  meals: Meal[];
  weights: { id: string; value: number; unit: string }[];
}
interface PageOf<T> {
  items: T[];
  next_cursor: string | null;
  complete: boolean;
}

let t: TestApp;
let s: Setup;
let recordIds: number[];
const run = randomUUID().slice(0, 8);

const A = () => `/profiles/${s.profileA}`;
const B = () => `/profiles/${s.profileB}`;
const day = async (token: string, profileId: string, date: string) => {
  const res = await diary<{ days: Day[] }>(
    t,
    token,
    "GET",
    `/profiles/${profileId}/diary?from=${date}&to=${date}`,
  );
  expect(res.status).toBe(200);
  const found = res.body.days[0];
  if (!found) throw new Error("no day returned");
  return found;
};

/** Synthetic catalogue records: 1–3 unrelated, 4 and 5 sharing an eligible GTIN used by no fixture, 6 another source's copy. */
async function insertCatalogue(): Promise<number[]> {
  const release = await t.pool.query<{ id: string }>(
    `INSERT INTO catalogue_release (source, release, archive_sha256, read_count, record_count, rejected_count, rejected_reasons)
     VALUES ('off', $1, 'synthetic', 6, 6, 0, '{}') RETURNING id`,
    [`links-${run}`],
  );
  const ids: number[] = [];
  for (const [i, gtin] of [null, null, null, "05901234123457", "05901234123457", null].entries()) {
    const row = await t.pool.query<{ id: number }>(
      `INSERT INTO catalogue_record (release_id, source_id, name, barcode, gtin_key, nutrients)
       VALUES ($1, $2, $3, $4, $4, $5) RETURNING id::int AS id`,
      [
        release.rows[0]?.id,
        `r${i + 1}`,
        `zzlink${run} food ${i + 1}`,
        gtin,
        JSON.stringify({ proteins_100g: { value: String(10 + i), unit: null } }),
      ],
    );
    ids.push(row.rows[0]?.id ?? 0);
  }
  return ids;
}

beforeAll(async () => {
  t = await startApp();
  s = await setupProfiles(t);
  recordIds = await insertCatalogue();
});
afterAll(() => t.close());

describe("persistence and corrections (server side)", () => {
  it("stores a meal with each entry's single source and note, and reads back the same values", async () => {
    const created = await diary<{ meal: Meal }>(t, s.token, "POST", `${A()}/meals`, {
      diary_date: "2026-03-01",
      label: "Breakfast",
      entries: [
        { ...estimate("Porridge", 320), nutrients: { energy_kcal: 320, protein_g: 11 } },
        {
          diary_only_reason: "one_off_restaurant",
          name: "Yoghurt",
          quantity: 150,
          unit: "g",
          nutrients: { energy_kcal: 90, fat_g: 0 },
          source: "label",
          note: "label per 100 g, scaled to 150 g",
          label: { basis_amount: 100, basis_unit: "g", nutrients: { energy_kcal: 60, fat_g: 0 } },
        },
        {
          diary_only_reason: "one_off_restaurant",
          name: "Oats from catalogue",
          quantity: 40,
          unit: "g",
          nutrients: { energy_kcal: 150 },
          source: "dataset",
          note: "40 g of the record's 100 g values",
          catalogue_record_id: recordIds[0],
        },
      ],
    });
    expect(created.status).toBe(201);
    const read = await day(s.token, s.profileA, "2026-03-01");
    expect(read.meals).toEqual([created.body.meal]);
    const [porridge, yoghurt, oats] = created.body.meal.entries;
    expect(porridge?.nutrients).toEqual({ energy_kcal: 320, protein_g: 11 });
    expect(porridge?.nutrients).not.toHaveProperty("fat_g");
    expect(yoghurt?.nutrients.fat_g).toBe(0);
    expect(yoghurt?.label).toEqual({
      basis_amount: 100,
      basis_unit: "g",
      nutrients: { energy_kcal: 60, fat_g: 0 },
    });
    expect(oats).toMatchObject({ source: "dataset", catalogue_record_id: recordIds[0] });
  });

  it("changes only a portion or a calorie value, or deletes one entry, leaving the rest untouched", async () => {
    const created = await diary<{ meal: Meal }>(t, s.token, "POST", `${A()}/meals`, {
      diary_date: "2026-03-02",
      entries: [
        estimate("Toast", 200),
        { ...estimate("Butter", 70), nutrients: { energy_kcal: 70, fat_g: 8, saturated_fat_g: 5 } },
        estimate("Jam", 50),
      ],
    });
    const [toast, butter, jam] = created.body.meal.entries;
    if (!toast || !butter || !jam) throw new Error("entries missing");
    const portion = await diary<{ entry: Entry }>(
      t,
      s.token,
      "PATCH",
      `${A()}/entries/${toast.id}?version=1`,
      {
        quantity: 2,
        nutrients: { energy_kcal: 400 },
        note: "two slices; one-slice estimate doubled",
      },
    );
    expect(portion.status).toBe(200);
    expect(portion.body.entry).toMatchObject({
      quantity: 2,
      nutrients: { energy_kcal: 400 },
      name: "Toast",
      source: "estimate",
      version: 2,
    });
    const calories = await diary<{ entry: Entry }>(
      t,
      s.token,
      "PATCH",
      `${A()}/entries/${butter.id}?version=1`,
      {
        nutrients: { energy_kcal: 90 },
        note: "corrected after reading the label",
      },
    );
    expect(calories.body.entry).toMatchObject({
      quantity: 1,
      nutrients: { energy_kcal: 90 },
      source: "estimate",
    });
    expect((await diary(t, s.token, "DELETE", `${A()}/entries/${jam.id}?version=1`)).status).toBe(
      200,
    );

    const read = await day(s.token, s.profileA, "2026-03-02");
    expect(
      read.meals[0]?.entries.map((e) => [e.name, e.quantity, e.nutrients.energy_kcal]),
    ).toEqual([
      ["Toast", 2, 400],
      ["Butter", 1, 90],
    ]);
  });

  it("adds food after a daily summary, to an existing meal or as a new one", async () => {
    const created = await diary<{ meal: Meal }>(t, s.token, "POST", `${A()}/meals`, {
      diary_date: "2026-03-03",
      entries: [estimate("Dinner", 600)],
    });
    await day(s.token, s.profileA, "2026-03-03");
    const added = await diary<{ meal: Meal; created_entry_ids: string[] }>(
      t,
      s.token,
      "POST",
      `${A()}/meals/${created.body.meal.id}/entries`,
      { entries: [estimate("Late snack", 150)] },
    );
    expect(added.status).toBe(201);
    expect(added.body.meal.entries.map((e) => e.name)).toEqual(["Dinner", "Late snack"]);
    expect(added.body.created_entry_ids).toHaveLength(1);
  });

  it("refuses a stale meal deletion after its entries changed, keeping the new food", async () => {
    const created = await diary<{ meal: Meal }>(t, s.token, "POST", `${A()}/meals`, {
      diary_date: "2026-03-07",
      entries: [estimate("Pasta", 600)],
    });
    const mealPath = `${A()}/meals/${created.body.meal.id}`;
    const added = await diary<{ meal: Meal }>(t, s.token, "POST", `${mealPath}/entries`, {
      entries: [estimate("Dessert", 300)],
    });
    expect(added.body.meal.version).toBe(2);
    const stale = await diary<{ code: string; current: Meal }>(
      t,
      s.token,
      "DELETE",
      `${mealPath}?version=1`,
    );
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("version_conflict");
    expect(stale.body.current.entries.map((e) => e.name)).toEqual(["Pasta", "Dessert"]);

    // Editing or deleting an entry also advances the meal and reports its new version.
    const dessert = added.body.meal.entries[1]?.id ?? "";
    const edited = await diary<{ meal: { version: number } }>(
      t,
      s.token,
      "PATCH",
      `${A()}/entries/${dessert}?version=1`,
      {
        quantity: 2,
        nutrients: { energy_kcal: 600 },
      },
    );
    expect(edited.body.meal.version).toBe(3);
    const removed = await diary<{ meal: { version: number } }>(
      t,
      s.token,
      "DELETE",
      `${A()}/entries/${dessert}?version=2`,
    );
    expect(removed.body.meal.version).toBe(4);
    expect(
      (await diary(t, s.token, "PATCH", `${mealPath}?version=3`, { label: "Dinner" })).status,
    ).toBe(409);
    expect((await diary(t, s.token, "DELETE", `${mealPath}?version=4`)).status).toBe(200);
    expect((await day(s.token, s.profileA, "2026-03-07")).meals).toEqual([]);
  });

  // Every path locks the meal before its entries; either write may win, but none fails with 500.
  for (const entryWrite of ["PATCH", "DELETE"] as const) {
    it(`never deadlocks when an entry ${entryWrite === "PATCH" ? "edit" : "delete"} races a whole-meal delete`, async () => {
      for (let round = 0; round < 15; round++) {
        const created = await diary<{ meal: Meal }>(t, s.token, "POST", `${A()}/meals`, {
          diary_date: "2026-03-08",
          entries: [estimate("Race A", 100), estimate("Race B", 100)],
        });
        const entryPath = `${A()}/entries/${created.body.meal.entries[0]?.id ?? ""}?version=1`;
        const [entry, meal] = await Promise.all([
          entryWrite === "PATCH"
            ? diary(t, s.token, "PATCH", entryPath, { note: "edited during a race" })
            : diary(t, s.token, "DELETE", entryPath),
          diary(t, s.token, "DELETE", `${A()}/meals/${created.body.meal.id}?version=1`),
        ]);
        expect([entry.status, meal.status], `${entryWrite} round ${round}`).not.toContain(500);
        // Exactly one wins: the entry write (meal delete then conflicts) or the meal delete (entry gone).
        expect([entry.status, meal.status].sort(), `${entryWrite} round ${round}`).toEqual(
          meal.status === 200 ? [200, 404] : [200, 409],
        );
      }
      expect((await day(s.token, s.profileA, "2026-03-08")).meals.every((m) => m.version > 1)).toBe(
        true,
      );
    });
  }

  it("corrects a meal's date and label with a version check", async () => {
    const created = await diary<{ meal: Meal }>(t, s.token, "POST", `${A()}/meals`, {
      diary_date: "2026-03-04",
      label: "Lunch",
      entries: [estimate("Soup", 250)],
    });
    const id = created.body.meal.id;
    const moved = await diary<{ meal: Meal }>(t, s.token, "PATCH", `${A()}/meals/${id}?version=1`, {
      diary_date: "2026-03-05",
      label: "Dinner",
    });
    expect(moved.body.meal).toMatchObject({
      diary_date: "2026-03-05",
      label: "Dinner",
      version: 2,
    });
    const stale = await diary<{ code: string; current: Meal }>(
      t,
      s.token,
      "PATCH",
      `${A()}/meals/${id}?version=1`,
      {
        label: "Supper",
      },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("version_conflict");
    expect(stale.body.current).toMatchObject({ label: "Dinner", version: 2 });
    expect((await day(s.token, s.profileA, "2026-03-04")).meals).toEqual([]);
  });

  it("rejects unknown nutrient keys and entries that break the source rule", async () => {
    const bad = [
      { ...estimate("Cake", 300), nutrients: { energy_kcal: 300, vitamin_c_mg: 2 } },
      { ...estimate("Cake", 300), nutrients: { energy_kcal: -1 } },
      { ...estimate("Cake", 300), source: "dataset" },
      { ...estimate("Cake", 300), source: "label" },
      { ...estimate("Cake", 300), source: "dataset", catalogue_record_id: 2 ** 31 - 1 },
      { ...estimate("Cake", 300), source: "photo" },
      { ...estimate("Cake", 300), note: undefined },
    ];
    for (const entry of bad) {
      const res = await diary(t, s.token, "POST", `${A()}/meals`, {
        diary_date: "2026-03-06",
        entries: [entry],
      });
      expect(res.status, JSON.stringify(entry)).toBe(400);
      expect(res.body).toMatchObject({ code: "invalid_input" });
    }
    expect((await day(s.token, s.profileA, "2026-03-06")).meals).toEqual([]);
  });
});

describe("reliability (T4 server side)", () => {
  it("replays a lost-response retry without a second write, but allows a deliberate repeat", async () => {
    const body = { diary_date: "2026-04-01", entries: [estimate("Coffee", 5)] };
    const requestId = randomUUID();
    const first = await diary<{ meal: Meal }>(t, s.token, "POST", `${A()}/meals`, body, requestId);
    const retry = await diary<{ meal: Meal }>(t, s.token, "POST", `${A()}/meals`, body, requestId);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect((await day(s.token, s.profileA, "2026-04-01")).meals).toHaveLength(1);
    await diary(t, s.token, "POST", `${A()}/meals`, body);
    expect((await day(s.token, s.profileA, "2026-04-01")).meals).toHaveLength(2);
  });

  it("writes once when identical requests race", async () => {
    const body = { diary_date: "2026-04-02", entries: [estimate("Tea", 2)] };
    const requestId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        diary<{ meal: Meal }>(t, s.token, "POST", `${A()}/meals`, body, requestId),
      ),
    );
    expect(new Set(results.map((r) => r.body.meal.id)).size).toBe(1);
    expect((await day(s.token, s.profileA, "2026-04-02")).meals).toHaveLength(1);
  });

  it("refuses a reused request ID for a different operation, body, account or version", async () => {
    const requestId = randomUUID();
    const created = await diary<{ meal: Meal }>(
      t,
      s.token,
      "POST",
      `${A()}/meals`,
      {
        diary_date: "2026-04-03",
        entries: [estimate("Apple", 80)],
      },
      requestId,
    );
    const reused = [
      await diary(
        t,
        s.token,
        "POST",
        `${A()}/meals`,
        { diary_date: "2026-04-03", entries: [estimate("Apple", 81)] },
        requestId,
      ),
      await diary(
        t,
        s.token,
        "POST",
        `${B()}/meals`,
        { diary_date: "2026-04-03", entries: [estimate("Apple", 80)] },
        requestId,
      ),
      await diary(
        t,
        s.token,
        "POST",
        `${A()}/weights`,
        { date: "2026-04-03", value: 70, unit: "kg" },
        requestId,
      ),
    ];
    for (const res of reused) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: "request_id_reused" });
    }
    const deleteId = randomUUID();
    const mealPath = `${A()}/meals/${created.body.meal.id}`;
    expect(
      (await diary(t, s.token, "DELETE", `${mealPath}?version=1`, undefined, deleteId)).status,
    ).toBe(200);
    expect(
      (await diary(t, s.token, "DELETE", `${mealPath}?version=1`, undefined, deleteId)).status,
    ).toBe(200);
    const otherVersion = await diary(
      t,
      s.token,
      "DELETE",
      `${mealPath}?version=2`,
      undefined,
      deleteId,
    );
    expect(otherVersion.body).toMatchObject({ code: "request_id_reused" });
    expect((await day(s.token, s.profileB, "2026-04-03")).meals).toEqual([]);
  });

  it("checks current authorization before replaying a stored result", async () => {
    const body = { date: "2026-04-04", value: 80, unit: "kg" };
    const spare = await connect(t, s.alice);
    const viaSpare = randomUUID();
    expect((await diary(t, spare.token, "POST", `${A()}/weights`, body, viaSpare)).status).toBe(
      201,
    );
    await call(t, "DELETE", `/api/manage/connections/${spare.grantId}`, { token: s.alice });
    const revoked = await diary(t, spare.token, "POST", `${A()}/weights`, body, viaSpare);
    expect(revoked.status).toBe(401);

    const dave = t.firebase.token(`dave-${randomUUID()}`, "Synthetic Dave");
    await join(t, s.token, dave);
    const daveProfile = (
      await call<{ profile: { profile_id: string } }>(t, "GET", "/api/manage/me", { token: dave })
    ).body.profile.profile_id;
    const path = `/profiles/${daveProfile}/weights`;
    const requestId = randomUUID();
    expect((await diary(t, s.token, "POST", path, body, requestId)).status).toBe(201);
    const aliceConnection = await t.pool.query<{ grant_id: string }>(
      "SELECT grant_id FROM connection_profiles WHERE account_id = $1",
      [daveProfile],
    );
    await call(t, "DELETE", `/api/manage/connections/${aliceConnection.rows[0]?.grant_id ?? ""}`, {
      token: dave,
    });
    const replay = await diary(t, s.token, "POST", path, body, requestId);
    expect(replay.status).toBe(403);
    expect(replay.body).toMatchObject({ code: "profile_not_available" });
  });

  it("surfaces concurrent edits instead of silently losing one", async () => {
    const created = await diary<{ meal: Meal }>(t, s.token, "POST", `${A()}/meals`, {
      diary_date: "2026-04-05",
      entries: [estimate("Rice", 300)],
    });
    const entryId = created.body.meal.entries[0]?.id ?? "";
    const [one, two] = await Promise.all([
      diary(t, s.token, "PATCH", `${A()}/entries/${entryId}?version=1`, {
        quantity: 2,
      }),
      diary(t, s.token, "PATCH", `${A()}/entries/${entryId}?version=1`, {
        nutrients: { energy_kcal: 350 },
      }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    const loser = one.status === 409 ? one : two;
    expect(loser.body).toMatchObject({ code: "version_conflict", current: { version: 2 } });
  });

  it("refuses an oversized body as invalid input", async () => {
    const res = await diary(t, s.token, "POST", `${A()}/meals`, {
      diary_date: "2026-04-07",
      entries: [{ ...estimate("Big", 1), note: "x".repeat(1_100_000) }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_input" });
  });

  it("requires a request ID on every write", async () => {
    const res = await call(t, "POST", `/api/v1${A()}/weights`, {
      token: s.token,
      body: { date: "2026-04-06", value: 70, unit: "kg" },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_input" });
  });
});

describe("isolation (T3 on diary routes)", () => {
  it("reaches only profiles on the connection, without cross-profile effects", async () => {
    const meal = await diary<{ meal: Meal }>(t, s.token, "POST", `${B()}/meals`, {
      diary_date: "2026-05-01",
      entries: [estimate("B's lunch", 500)],
    });
    expect(meal.status).toBe(201);
    // A connection B never joined cannot read or write B; arbitrary profile IDs never grant access.
    for (const path of [
      `${B()}/diary?from=2026-05-01&to=2026-05-01`,
      `/profiles/${randomUUID()}/diary?from=2026-05-01&to=2026-05-01`,
      "/profiles/not-a-uuid/diary?from=2026-05-01&to=2026-05-01",
    ]) {
      const res = await diary(t, s.carolToken, "GET", path);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "profile_not_available" });
    }
    expect(
      (
        await diary(t, s.carolToken, "POST", `${B()}/weights`, {
          date: "2026-05-01",
          value: 1,
          unit: "kg",
        })
      ).status,
    ).toBe(403);
    // B's record IDs are not found under A's path, even on a connection reaching both.
    const entryId = meal.body.meal.entries[0]?.id ?? "";
    expect(
      (
        await diary(t, s.token, "PATCH", `${A()}/entries/${entryId}?version=1`, {
          quantity: 3,
        })
      ).status,
    ).toBe(404);
    expect(
      (await diary(t, s.token, "DELETE", `${A()}/meals/${meal.body.meal.id}?version=1`)).status,
    ).toBe(404);
    // B's product cannot be referenced from A's entries.
    const product = await diary<{ product: { id: string } }>(
      t,
      s.token,
      "POST",
      `${B()}/products`,
      {
        name: "B's bread",
        food_kind: "product",
        preparation: { state: "unspecified" },
        provenance: { source: "estimate" },
        basis_amount: 100,
        basis_unit: "g",
        nutrients: { energy_kcal: 250 },
      },
    );
    const crossRef = await diary(t, s.token, "POST", `${A()}/meals`, {
      diary_date: "2026-05-01",
      entries: [estimate("Bread", 250, { product_id: product.body.product.id })],
    });
    expect(crossRef.status).toBe(400);
    expect((await day(s.token, s.profileB, "2026-05-01")).meals[0]?.entries[0]?.quantity).toBe(1);
  });

  it("keeps diary data when a profile leaves a connection", async () => {
    const spare = await connect(t, s.alice);
    await diary(t, spare.token, "POST", `${A()}/weights`, {
      date: "2026-05-02",
      value: 81,
      unit: "kg",
    });
    await call(t, "DELETE", `/api/manage/connections/${spare.grantId}`, { token: s.alice });
    expect((await diary(t, spare.token, "GET", `${A()}/weights`)).status).toBe(401);
    expect((await day(s.token, s.profileA, "2026-05-02")).weights.map((w) => w.value)).toEqual([
      81,
    ]);
    expect((await day(s.alice, s.profileA, "2026-05-02")).weights.map((w) => w.value)).toEqual([
      81,
    ]);
  });
});

describe("reuse (server side)", () => {
  it("keeps logged meals unchanged when products and recipes are edited or deleted", async () => {
    const product = await diary<{
      product: { id: string; version: number; gtin_key: string | null };
    }>(t, s.token, "POST", `${A()}/products`, {
      name: "Synthetic muesli",
      food_kind: "product",
      preparation: { state: "unspecified" },
      provenance: { source: "estimate" },
      brand: "Testbrand",
      barcode: "4006381333931",
      basis_amount: 100,
      basis_unit: "g",
      nutrients: { energy_kcal: 370, protein_g: 10 },
      preferred_record_ids: [recordIds[3]],
      note: "label photo, synthetic",
    });
    expect(product.status).toBe(201);
    expect(product.body.product.gtin_key).toBe("04006381333931");
    const ingredientIds: string[] = [];
    for (const name of ["Beans", "Lentils"]) {
      const saved = await diary<{ product: { id: string } }>(
        t,
        s.token,
        "POST",
        `${A()}/products`,
        {
          name,
          food_kind: "basic",
          preparation: { state: "unspecified" },
          provenance: { source: "estimate" },
          basis_amount: 100,
          basis_unit: "g",
          nutrients: { energy_kcal: 150 },
        },
      );
      expect(saved.status).toBe(201);
      ingredientIds.push(saved.body.product.id);
    }
    const recipe = await diary<{ recipe: { id: string; version: number; ingredients: unknown[] } }>(
      t,
      s.token,
      "POST",
      `${A()}/recipes`,
      {
        name: "Synthetic chili",
        yield_amount: 1200,
        yield_unit: "g",
        servings: 4,
        nutrients: { energy_kcal: 2000 },
        ingredients: [
          { ...estimate("Beans", 600, { product_id: ingredientIds[0] }), quantity: 400, unit: "g" },
          estimate("Muesli?", 370, { product_id: product.body.product.id }),
        ],
      },
    );
    expect(recipe.body.recipe.ingredients).toHaveLength(2);
    const meal = await diary<{ meal: Meal }>(t, s.token, "POST", `${A()}/meals`, {
      diary_date: "2026-06-01",
      entries: [
        {
          ...estimate("Muesli", 222, { product_id: product.body.product.id }),
          quantity: 60,
          unit: "g",
          product_id: product.body.product.id,
        },
        estimate("Chili", 500, { recipe_id: recipe.body.recipe.id }),
      ],
    });
    const before = meal.body.meal;

    const edited = await diary(
      t,
      s.token,
      "PUT",
      `${A()}/products/${product.body.product.id}?version=1`,
      {
        name: "Synthetic muesli (new recipe)",
        food_kind: "product",
        preparation: { state: "unspecified" },
        provenance: { source: "estimate" },
        basis_amount: 100,
        basis_unit: "g",
        nutrients: { energy_kcal: 390 },
      },
    );
    expect(edited.status).toBe(200);
    const editedRecipe = await diary<{
      recipe: { ingredients: { name: string }[]; version: number };
    }>(t, s.token, "PUT", `${A()}/recipes/${recipe.body.recipe.id}?version=1`, {
      name: "Synthetic chili",
      servings: 6,
      nutrients: { energy_kcal: 2400 },
      ingredients: [{ ...estimate("Lentils", 700, { product_id: ingredientIds[1] }) }],
    });
    expect(editedRecipe.body.recipe).toMatchObject({
      version: 2,
      ingredients: [{ name: "Lentils" }],
    });
    expect((await day(s.token, s.profileA, "2026-06-01")).meals).toEqual([before]);

    expect(
      (await diary(t, s.token, "DELETE", `${A()}/products/${product.body.product.id}?version=2`))
        .status,
    ).toBe(200);
    expect(
      (await diary(t, s.token, "DELETE", `${A()}/recipes/${recipe.body.recipe.id}?version=2`))
        .status,
    ).toBe(200);
    const after = (await day(s.token, s.profileA, "2026-06-01")).meals[0];
    expect(
      after?.entries.map((e) => [e.name, e.quantity, e.nutrients, e.product_id, e.recipe_id]),
    ).toEqual([
      ["Muesli", 60, { energy_kcal: 222 }, null, null],
      ["Chili", 1, { energy_kcal: 500 }, null, null],
    ]);
  });
});

describe("targets and weight", () => {
  it("finds each active target beyond 50 future variants and binds effective-date cursors", async () => {
    const owner = t.firebase.token(`history-${randomUUID()}`, "Synthetic history");
    const { token } = await connect(t, owner);
    const profile = await ownProfile(t, owner);
    const path = `/profiles/${profile}/targets`;
    const save = async (kind: "normal" | "training", date: string) => {
      const saved = await diary<{ target: { id: string } }>(t, token, "POST", path, {
        kind,
        effective_from: date,
        values: { energy_kcal: { value: 2000 } },
      });
      expect(saved.status).toBe(201);
      return saved.body.target.id;
    };
    await save("normal", "2025-01-01");
    const normal = await save("normal", "2026-01-01");
    const training = await save("training", "2026-01-01");
    for (let i = 0; i < 60; i++) {
      await save("normal", new Date(Date.UTC(2027, 0, i + 1)).toISOString().slice(0, 10));
    }
    const first = await diary<PageOf<{ effective_from: string }>>(
      t,
      token,
      "GET",
      `${path}?limit=50`,
    );
    expect(first.body.items).toHaveLength(50);
    expect(first.body.items.every((target) => target.effective_from > "2026-10-20")).toBe(true);
    const current = await diary<PageOf<{ id: string }>>(
      t,
      token,
      "GET",
      `${path}?kind=normal&effective_on=2026-10-20&limit=1`,
    );
    expect(current.body.items.map((target) => target.id)).toEqual([normal]);
    expect(
      (
        await diary<PageOf<{ id: string }>>(
          t,
          token,
          "GET",
          `${path}?kind=training&effective_on=2026-10-20&limit=1`,
        )
      ).body.items.map((target) => target.id),
    ).toEqual([training]);
    const website = await call<PageOf<{ id: string }>>(
      t,
      "GET",
      `/api/v1${path}?kind=normal&effective_on=2026-10-20&limit=1`,
      { token: owner },
    );
    expect(website.status).toBe(200);
    expect(website.body.items[0]?.id).toBe(normal);
    expect(current.body.next_cursor).not.toBeNull();
    expect(
      (
        await diary(
          t,
          token,
          "GET",
          `${path}?kind=normal&effective_on=2026-10-21&cursor=${encodeURIComponent(current.body.next_cursor ?? "")}`,
        )
      ).status,
    ).toBe(400);
    expect((await diary(t, token, "GET", `${path}?effective_on=invalid`)).status).toBe(400);
    expect((await diary(t, s.token, "GET", `${path}?effective_on=2026-10-20`)).status).toBe(403);
  });

  it("lists every saved variant and resolves each day's target, with the normal-day default", async () => {
    const save = (body: unknown) =>
      diary<{ target: { id: string } }>(t, s.token, "POST", `${B()}/targets`, body);
    const normalJan = await save({
      kind: "normal",
      effective_from: "2026-01-01",
      values: { energy_kcal: { value: 2200 }, protein_g: { min: 120 } },
    });
    const training = await save({
      kind: "training",
      effective_from: "2026-01-10",
      values: { energy_kcal: { min: 2600, max: 2800 } },
    });
    const normalFeb = await save({
      kind: "normal",
      effective_from: "2026-02-01",
      values: { energy_kcal: { value: 2100 } },
    });
    expect([normalJan.status, training.status, normalFeb.status]).toEqual([201, 201, 201]);
    expect(
      (
        await save({
          kind: "normal",
          effective_from: "2026-02-01",
          values: { energy_kcal: { value: 1 } },
        })
      ).body,
    ).toMatchObject({
      code: "invalid_input",
    });
    expect(
      (
        await save({
          kind: "normal",
          effective_from: "2026-02-02",
          values: { energy_kcal: { min: 3, max: 2 } },
        })
      ).status,
    ).toBe(400);

    const listed = await diary<PageOf<{ kind: string; effective_from: string }>>(
      t,
      s.token,
      "GET",
      `${B()}/targets`,
    );
    expect(listed.body.items.map((v) => [v.kind, v.effective_from])).toEqual([
      ["normal", "2026-02-01"],
      ["training", "2026-01-10"],
      ["normal", "2026-01-01"],
    ]);
    const trainingOnly = await diary<PageOf<{ kind: string }>>(
      t,
      s.token,
      "GET",
      `${B()}/targets?kind=training`,
    );
    expect(trainingOnly.body.items).toHaveLength(1);

    expect(await day(s.token, s.profileB, "2026-01-15")).toMatchObject({
      target_kind: "normal",
      target_kind_selected: false,
      target: { id: normalJan.body.target.id },
    });
    expect((await day(s.token, s.profileB, "2025-12-31")).target).toBeNull();
    const selected = await diary(t, s.token, "PUT", `${B()}/days/2026-02-03/target-kind`, {
      kind: "training",
    });
    expect(selected.body).toMatchObject({
      day: { target_kind: "training", target: { id: training.body.target.id } },
    });
    expect(await day(s.token, s.profileB, "2026-02-03")).toMatchObject({
      target_kind: "training",
      target_kind_selected: true,
      target: { id: training.body.target.id },
    });
    expect((await day(s.token, s.profileB, "2026-02-04")).target?.id).toBe(
      normalFeb.body.target.id,
    );
    await diary(t, s.token, "PUT", `${B()}/days/2026-01-05/target-kind`, {
      kind: "training",
    });
    expect((await day(s.token, s.profileB, "2026-01-05")).target).toBeNull();
  });

  it("surfaces conflicting day selections instead of overwriting them", async () => {
    const path = `${A()}/days/2026-02-10/target-kind`;
    const first = await diary<{ day: { target_kind: string; target_kind_version: number } }>(
      t,
      s.token,
      "PUT",
      path,
      { kind: "training" },
    );
    expect(first.body.day).toMatchObject({ target_kind: "training", target_kind_version: 1 });
    // A change made without the version read, or with an old one, returns the stored selection.
    const blind = await diary<{
      code: string;
      current: { target_kind: string; target_kind_version: number };
    }>(t, s.token, "PUT", path, { kind: "normal" });
    expect(blind.status).toBe(409);
    expect(blind.body).toMatchObject({
      code: "version_conflict",
      current: { target_kind: "training", target_kind_version: 1 },
    });
    const [one, two] = await Promise.all([
      diary(t, s.token, "PUT", `${path}?version=1`, { kind: "normal" }),
      diary(t, s.token, "PUT", `${path}?version=1`, { kind: "training" }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    const read = await day(s.token, s.profileA, "2026-02-10");
    expect(read).toMatchObject({ target_kind_selected: true, target_kind_version: 2 });
    // A version for a day that has no selection yet is a conflict too.
    const fresh = await diary(t, s.token, "PUT", `${A()}/days/2026-02-11/target-kind?version=1`, {
      kind: "training",
    });
    expect(fresh.body).toMatchObject({
      code: "version_conflict",
      current: { target_kind_selected: false, target_kind_version: null },
    });
  });

  it("keeps weight history with units as supplied and filters by date", async () => {
    for (const [date, value, unit] of [
      ["2026-07-01", 80.5, "kg"],
      ["2026-07-08", 177.2, "lb"],
      ["2026-07-15", 79.9, "kg"],
    ] as const) {
      expect(
        (
          await diary(t, s.token, "POST", `${A()}/weights`, {
            date,
            value,
            unit,
            note: "morning",
          })
        ).status,
      ).toBe(201);
    }
    const july = await diary<PageOf<{ date: string; value: number; unit: string }>>(
      t,
      s.token,
      "GET",
      `${A()}/weights?from=2026-07-02&to=2026-07-31`,
    );
    expect(july.body.items.map((w) => [w.date, w.value, w.unit])).toEqual([
      ["2026-07-15", 79.9, "kg"],
      ["2026-07-08", 177.2, "lb"],
    ]);
    await diary(t, s.token, "POST", `${A()}/weights`, {
      date: "2026-07-08",
      value: 80.1,
      unit: "kg",
    });
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: PageOf<{ date: string; value: number }> } = await diary<
        PageOf<{ date: string; value: number }>
      >(
        t,
        s.token,
        "GET",
        `${A()}/weights?from=2026-07-01&to=2026-07-31&limit=1${cursor ? `&cursor=${cursor}` : ""}`,
      );
      paged.push(...page.body.items.map((w) => `${w.date} ${w.value}`));
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(paged).toEqual([
      "2026-07-15 79.9",
      "2026-07-08 80.1",
      "2026-07-08 177.2",
      "2026-07-01 80.5",
    ]);
  });

  it("limits a diary read to 31 days", async () => {
    expect(
      (await diary(t, s.token, "GET", `${A()}/diary?from=2026-01-01&to=2026-01-31`)).status,
    ).toBe(200);
    expect(
      (await diary(t, s.token, "GET", `${A()}/diary?from=2026-01-01&to=2026-02-01`)).status,
    ).toBe(400);
  });
});

describe("paging", () => {
  it("returns every item exactly once across pages and reports completeness", async () => {
    const account = `/profiles/${s.profileB}`;
    const created: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const res = await diary<{ product: { id: string } }>(
        t,
        s.token,
        "POST",
        `${account}/products`,
        {
          name: `Pager ${run} ${i}`,
          food_kind: "product",
          preparation: { state: "unspecified" },
          provenance: { source: "estimate" },
          basis_amount: 1,
          basis_unit: "piece",
          nutrients: {},
        },
      );
      created.push(res.body.product.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    const completes: boolean[] = [];
    do {
      const query = `q=${encodeURIComponent(`Pager ${run}`)}&limit=3${cursor ? `&cursor=${cursor}` : ""}`;
      const page: { body: PageOf<{ id: string }> } = await diary<PageOf<{ id: string }>>(
        t,
        s.token,
        "GET",
        `${account}/products?${query}`,
      );
      seen.push(...page.body.items.map((p) => p.id));
      completes.push(page.body.complete);
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(seen).toEqual(created);
    expect(completes).toEqual([false, false, true]);

    const first = await diary<PageOf<{ id: string }>>(
      t,
      s.token,
      "GET",
      `${account}/products?q=${encodeURIComponent(`Pager ${run}`)}&limit=3`,
    );
    const elsewhere = [
      `${account}/products?q=other&limit=3&cursor=${first.body.next_cursor ?? ""}`,
      `${A()}/products?q=${encodeURIComponent(`Pager ${run}`)}&limit=3&cursor=${first.body.next_cursor ?? ""}`,
    ];
    for (const path of elsewhere) {
      const res = await diary(t, s.token, "GET", path);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "invalid_input" });
    }
    expect((await diary(t, s.token, "GET", `${account}/products?limit=51`)).status).toBe(400);
    // A hand-made cursor with the right binding but a malformed position is refused, not passed to SQL.
    const forged = encodeCursor(cursorBinding(s.profileB, ["weights", null, null]), [
      "not-a-date",
      "x",
    ]);
    const res = await diary(t, s.token, "GET", `${account}/weights?cursor=${forged}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_input" });
  });

  it("searches entries, products and recipes in one paged list", async () => {
    const word = `zzsearch${run}`;
    await diary(t, s.token, "POST", `${A()}/meals`, {
      diary_date: "2026-08-01",
      entries: [estimate(`${word} soup`, 100)],
    });
    const product = await diary<{ product: { id: string } }>(
      t,
      s.token,
      "POST",
      `${A()}/products`,
      {
        name: `${word} crackers`,
        food_kind: "product",
        preparation: { state: "unspecified" },
        provenance: { source: "estimate" },
        basis_amount: 1,
        basis_unit: "pack",
        nutrients: {},
      },
    );
    await diary(t, s.token, "POST", `${A()}/recipes`, {
      name: `${word} stew`,
      servings: 1,
      nutrients: {},
      ingredients: [estimate("Ingredient", 1, { product_id: product.body.product.id })],
    });
    const types: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: PageOf<{ type: string }> } = await diary<PageOf<{ type: string }>>(
        t,
        s.token,
        "GET",
        `${A()}/search?q=${word}&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      types.push(...page.body.items.map((i) => i.type));
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(types).toEqual(["recipe", "product", "entry"]);
    const other = await diary<PageOf<unknown>>(t, s.token, "GET", `${B()}/search?q=${word}`);
    expect(other.body).toEqual({ items: [], next_cursor: null, complete: true });
  });
});

describe("catalogue links (CA-6, T5)", () => {
  interface Group {
    records: { id: number; nutrients: Record<string, { value: string }> }[];
    links: { record_a: number; record_b: number }[];
  }
  const groups = async (credential: string, account: string) => {
    const res = await diary<PageOf<Group>>(
      t,
      credential,
      "GET",
      `/profiles/${account}/catalogue?q=zzlink${run}`,
    );
    expect(res.status).toBe(200);
    return res.body.items
      .map((g) => g.records.map((r) => recordIds.indexOf(r.id) + 1))
      .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  };
  const link = (a: number, b: number, method = "PUT", account = s.profileA) =>
    diary(
      t,
      s.token,
      method,
      `/profiles/${account}/food-links/${recordIds[a - 1] ?? 0}/${recordIds[b - 1] ?? 0}`,
    );

  it("merges and separates groups as links are added and removed, per account", async () => {
    expect(await groups(s.token, s.profileA)).toEqual([[1], [2], [3], [4, 5], [6]]);
    expect((await link(1, 2)).status).toBe(200);
    expect((await link(4, 3)).status).toBe(200);
    expect(await groups(s.token, s.profileA)).toEqual([[1, 2], [3, 4, 5], [6]]);
    // Bridge: 1–2 and 3–4 merge through 2–3, then separate again when only that link is removed.
    await link(2, 3);
    expect(await groups(s.token, s.profileA)).toEqual([[1, 2, 3, 4, 5], [6]]);
    expect((await link(3, 2, "DELETE")).status).toBe(200);
    expect(await groups(s.token, s.profileA)).toEqual([[1, 2], [3, 4, 5], [6]]);
    // Alternate path: with 1–3 also present, removing 2–3 keeps one group.
    await link(2, 3);
    await link(1, 3);
    await link(2, 3, "DELETE");
    expect(await groups(s.token, s.profileA)).toEqual([[1, 2, 3, 4, 5], [6]]);
    await link(1, 3, "DELETE");
    // GTIN path: linking 3–5 and removing 3–4 keeps 3 with 4 through 5's shared GTIN.
    await link(3, 5);
    await link(3, 4, "DELETE");
    expect(await groups(s.token, s.profileA)).toEqual([[1, 2], [3, 4, 5], [6]]);
    // B's search is unaffected by A's links; B's own link does not change A's groups.
    expect(await groups(s.token, s.profileB)).toEqual([[1], [2], [3], [4, 5], [6]]);
    await link(6, 1, "PUT", s.profileB);
    expect(await groups(s.token, s.profileB)).toEqual([[1, 6], [2], [3], [4, 5]]);
    expect(await groups(s.token, s.profileA)).toEqual([[1, 2], [3, 4, 5], [6]]);
  });

  it("keeps each record's conflicting values and reads one record with its group", async () => {
    const read = await diary<{ record: { id: number }; group: Group }>(
      t,
      s.token,
      "GET",
      `${A()}/catalogue/records/${recordIds[3] ?? 0}`,
    );
    expect(read.body.group.records.map((r) => r.nutrients.proteins_100g?.value)).toEqual([
      "12",
      "13",
      "14",
    ]);
    expect(read.body.group.links.length).toBeGreaterThan(0);
    expect((await diary(t, s.token, "GET", `${A()}/catalogue/records/${2 ** 31 - 1}`)).status).toBe(
      404,
    );
    const byGtin = await diary<PageOf<Group>>(
      t,
      s.token,
      "GET",
      `${A()}/catalogue?gtin=5901234123457`,
    );
    expect(byGtin.body.items[0]?.records.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects self-links, unknown records and removing a missing link", async () => {
    expect((await link(2, 2)).status).toBe(400);
    expect(
      (await diary(t, s.token, "PUT", `${A()}/food-links/${recordIds[0] ?? 0}/${2 ** 31 - 1}`))
        .status,
    ).toBe(400);
    expect((await link(5, 6, "DELETE")).status).toBe(404);
  });

  it("never changes logged meals when links change", async () => {
    const meal = await diary<{ meal: Meal }>(t, s.token, "POST", `${A()}/meals`, {
      diary_date: "2026-09-01",
      entries: [
        { ...estimate("Record 1 food", 120), source: "dataset", catalogue_record_id: recordIds[0] },
      ],
    });
    await link(1, 6);
    await link(1, 6, "DELETE");
    expect((await day(s.token, s.profileA, "2026-09-01")).meals).toEqual([meal.body.meal]);
  });
});
