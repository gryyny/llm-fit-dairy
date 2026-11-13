import { afterAll, beforeAll, expect, it } from "vitest";
import { startApp, type TestApp } from "./app.js";
import { diary, estimate, setupProfiles, legacyProduct, type Setup } from "./diary-helpers.js";

let t: TestApp;
let s: Setup;
beforeAll(async () => {
  t = await startApp();
  s = await setupProfiles(t);
});
afterAll(() => t.close());
interface Food {
  id: string;
  type: "product" | "recipe";
  name: string;
  food_kind: string | null;
  last_used_at: string | null;
}
interface Page {
  items: Food[];
  next_cursor: string | null;
  complete: boolean;
}
const root = () => `/profiles/${s.profileA}`;

it("offers bounded legacy and translated-name candidates only from permitted profiles", async () => {
  const p = await setupProfiles(t);
  const id = await legacyProduct(t, p.profileA, "Azeite e tortitas");
  for (const q of ["Azeite", "олія"]) {
    const response = await diary<{
      items: Food[];
      fallback: { reason: string; items: Food[]; complete: boolean };
    }>(
      t,
      p.token,
      "GET",
      `/profiles/${p.profileA}/foods?food_kind=product&q=${encodeURIComponent(q)}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([]);
    expect(response.body.fallback).toMatchObject({
      complete: true,
      items: [{ id, food_kind: null }],
    });
    expect(response.body.fallback.reason).toBe(
      q === "Azeite" ? "unclassified_or_other_kind" : "name_may_be_in_another_language",
    );
  }
  expect(
    (await diary<{ items: Food[] }>(t, p.token, "GET", `/profiles/${p.profileB}/foods`)).body.items,
  ).toEqual([]);
  expect(
    (
      await diary<{ items: Food[] }>(
        t,
        p.token,
        "GET",
        `/profiles/${p.profileB}/foods?scope=connection`,
      )
    ).body.items,
  ).toMatchObject([{ id }]);
  expect(
    (
      await diary<{ items: Food[] }>(
        t,
        p.carolToken,
        "GET",
        `/profiles/${p.carolProfile}/foods?scope=connection`,
      )
    ).body.items,
  ).toEqual([]);
});

it("finds owned legacy barcodes and padded GTINs without inventing classification", async () => {
  const id = await legacyProduct(t, s.profileA, "Legacy identifier", "96385074", "00000096385074");
  for (const q of ["96385074", "00000096385074"]) {
    const found = await diary<Page>(t, s.token, "GET", `${root()}/foods?q=${q}`);
    expect(found.body.items).toMatchObject([{ id, food_kind: null, barcode: "96385074" }]);
    expect(
      (await diary<Page>(t, s.token, "GET", `/profiles/${s.profileB}/foods?q=${q}`)).body.items,
    ).toEqual([]);
  }
  expect(
    (await diary<Page>(t, s.token, "GET", `${root()}/foods?food_kind=unclassified&q=Legacy`)).body
      .items,
  ).toMatchObject([{ id, food_kind: null }]);
  expect(
    (
      await t.pool.query(
        "SELECT p.version,v.content->'foodKind' AS food_kind,v.content->'preparation' AS preparation,f.identity_key FROM products p JOIN food_revisions v ON v.id=p.revision_id JOIN food_definitions f ON f.id=p.food_id WHERE p.id=$1",
        [id],
      )
    ).rows,
  ).toEqual([{ version: 1, food_kind: null, preparation: null, identity_key: null }]);
  await t.pool.query("DELETE FROM products WHERE id=$1", [id]);
});

it("pages one compact library with filters, identification search, actual use and profile isolation", async () => {
  const ids: string[] = [];
  for (const [name, kind] of [
    ["Alpha", "basic"],
    ["Bravo", "product"],
    ["Charlie", "basic"],
    ["Delta", "product"],
  ]) {
    const saved = await diary<{ product: { id: string } }>(
      t,
      s.token,
      "POST",
      `${root()}/products`,
      {
        name,
        food_kind: kind,
        brand: "Synthetic",
        variant: name === "Bravo" ? "vanilla" : null,
        recognition_description: "Synthetic packaging",
        preparation: { state: "other", description: "oven baked" },
        provenance: { source: "estimate" },
        basis_amount: 100,
        basis_unit: "g",
        nutrients: { energy_kcal: 100 },
      },
    );
    expect(saved.status).toBe(201);
    ids.push(saved.body.product.id);
  }
  const legacy = await legacyProduct(t, s.profileA, "Echo");
  const recipe = await diary<{ recipe: { id: string } }>(t, s.token, "POST", `${root()}/recipes`, {
    name: "Foxtrot",
    servings: 2,
    recognition_description: "Green soup",
    nutrients: { energy_kcal: 200 },
    ingredients: [estimate("Alpha", 200, { product_id: ids[0] })],
  });
  for (const sort of ["name", "recent"]) {
    let cursor: string | null = null;
    const seen: Food[] = [];
    do {
      const page: { body: Page } = await diary<Page>(
        t,
        s.token,
        "GET",
        `${root()}/foods?limit=2&sort=${sort}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...page.body.items);
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(new Set(seen.map((f) => f.id)).size).toBe(6);
    if (sort === "name")
      expect(seen.map((f) => f.name)).toEqual([
        "Alpha",
        "Bravo",
        "Charlie",
        "Delta",
        "Echo",
        "Foxtrot",
      ]);
    expect(seen.find((f) => f.id === legacy)?.food_kind).toBeNull();
    expect(seen[0]).not.toHaveProperty("nutrients");
  }
  for (const [q, expected] of [
    ["vanilla", ["Bravo"]],
    ["oven baked", ["Alpha", "Bravo", "Charlie", "Delta"]],
    ["Green soup", ["Foxtrot"]],
  ] as const) {
    const found = await diary<Page>(
      t,
      s.token,
      "GET",
      `${root()}/foods?q=${encodeURIComponent(q)}&sort=name`,
    );
    expect(found.body.items.map((f) => f.name)).toEqual(expected);
  }
  const basics = await diary<Page>(
    t,
    s.token,
    "GET",
    `${root()}/foods?food_kind=basic&sort=name&limit=1`,
  );
  expect(basics.body.items.map((f) => f.name)).toEqual(["Alpha"]);
  const next = await diary<Page>(
    t,
    s.token,
    "GET",
    `${root()}/foods?food_kind=basic&sort=name&limit=1&cursor=${basics.body.next_cursor}`,
  );
  expect(next.body.items.map((f) => f.name)).toEqual(["Charlie"]);
  for (const query of [
    "food_kind=product&sort=name",
    "food_kind=basic&sort=recent",
    "food_kind=basic&sort=name&q=Alpha",
  ])
    expect(
      (await diary(t, s.token, "GET", `${root()}/foods?${query}&cursor=${basics.body.next_cursor}`))
        .status,
    ).toBe(400);
  expect(
    (await diary<Page>(t, s.token, "GET", `/profiles/${s.profileB}/foods`)).body.items,
  ).toEqual([]);
  const logged = await diary<{ meal: { entries: { id: string }[] } }>(
    t,
    s.token,
    "POST",
    `${root()}/meals`,
    {
      diary_date: "2020-01-01",
      entries: [
        estimate("Alpha", 50, { product_id: ids[0] }),
        estimate("Soup", 50, { recipe_id: recipe.body.recipe.id }),
      ],
    },
  );
  const recent = await diary<Page>(t, s.token, "GET", `${root()}/foods?sort=recent&limit=2`);
  expect(new Set(recent.body.items.map((f) => f.id))).toEqual(
    new Set([ids[0], recipe.body.recipe.id]),
  );
  expect(recent.body.items.every((f) => f.last_used_at !== null)).toBe(true);
  const entry = logged.body.meal.entries[0];
  await diary(t, s.token, "PATCH", `${root()}/entries/${entry?.id}?version=1`, {
    product_id: ids[1],
  });
  const changed = await diary<Page>(t, s.token, "GET", `${root()}/foods?sort=name`);
  expect(changed.body.items.find((f) => f.id === ids[0])?.last_used_at).toBeNull();
  expect(changed.body.items.find((f) => f.id === ids[1])?.last_used_at).not.toBeNull();
  expect((await diary(t, s.carolToken, "GET", `${root()}/products/${ids[0]}`)).status).toBe(403);
});
