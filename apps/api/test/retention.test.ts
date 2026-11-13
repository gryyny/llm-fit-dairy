import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

let t: TestApp;
let s: Setup;
beforeAll(async () => {
  t = await startApp();
  s = await setupProfiles(t);
});
afterAll(() => t.close());
const root = () => `/profiles/${s.profileA}`;
const product = {
  name: "Synthetic oats",
  food_kind: "product",
  barcode: "4006381333931",
  preparation: { state: "as_sold" },
  provenance: { source: "estimate" },
  basis_amount: 100,
  basis_unit: "g",
  nutrients: { energy_kcal: 370 },
};
const command = () => ({
  diary_date: "2026-10-20",
  entries: [estimate("Porridge", 222, { food_ref: "porridge" })],
  new_foods: [
    {
      client_ref: "porridge",
      type: "recipe",
      definition: {
        name: "Synthetic porridge",
        servings: 2,
        nutrients: { energy_kcal: 444 },
        ingredients: [estimate("Oats", 444, { food_ref: "oats" })],
      },
    },
    { client_ref: "oats", type: "product", definition: product },
  ],
});
interface Result {
  meal: {
    id: string;
    version: number;
    entries: {
      id: string;
      product_id: string | null;
      recipe_id: string | null;
      nutrients: Record<string, number>;
    }[];
  };
  retained_foods: { client_ref: string; id: string; version: number; outcome: string }[];
  created_entry_ids?: string[];
}
const savedCounts = async () =>
  (
    await t.pool.query<{ foods: string; recipes: string; meals: string; entries: string }>(
      "SELECT (SELECT count(*) FROM products WHERE account_id=$1) AS foods,(SELECT count(*) FROM recipes WHERE account_id=$1) AS recipes,(SELECT count(*) FROM meals WHERE account_id=$1) AS meals,(SELECT count(*) FROM entries WHERE account_id=$1) AS entries",
      [s.profileA],
    )
  ).rows[0];

describe("atomic food retention", () => {
  it("resolves products before recipes, replays mappings, and preserves supplied snapshots", async () => {
    const requestId = randomUUID();
    const body = command();
    const first = await diary<Result>(t, s.token, "POST", `${root()}/meals`, body, requestId);
    expect(first.status).toBe(201);
    expect(first.body.retained_foods.map((f) => f.client_ref)).toEqual(["porridge", "oats"]);
    expect(first.body.meal.entries[0]).toMatchObject({
      recipe_id: first.body.retained_foods[0]?.id,
      nutrients: { energy_kcal: 222 },
    });
    const recipe = await diary<{ recipe: { ingredients: { product_id: string }[] } }>(
      t,
      s.token,
      "GET",
      `${root()}/recipes/${first.body.retained_foods[0]?.id}`,
    );
    expect(recipe.body.recipe.ingredients[0]?.product_id).toBe(first.body.retained_foods[1]?.id);
    expect(
      (await diary<Result>(t, s.token, "POST", `${root()}/meals`, body, requestId)).body,
    ).toEqual(first.body);
    const second = await diary<Result>(t, s.token, "POST", `${root()}/meals`, body);
    expect(second.body.meal.id).not.toBe(first.body.meal.id);
    expect(second.body.retained_foods[1]).toMatchObject({
      id: first.body.retained_foods[1]?.id,
      outcome: "reused",
      version: 1,
    });
    const appended = await diary<Result>(
      t,
      s.token,
      "POST",
      `${root()}/meals/${first.body.meal.id}/entries`,
      { entries: [estimate("Oats", 74, { food_ref: "oats" })], new_foods: [body.new_foods[1]] },
    );
    expect(appended.status).toBe(201);
    expect(appended.body.retained_foods[0]?.id).toBe(first.body.retained_foods[1]?.id);
    expect(appended.body.meal.entries.at(-1)?.nutrients).toEqual({ energy_kcal: 74 });
    expect(appended.body.created_entry_ids).toHaveLength(1);
  });

  it("rejects duplicate, unused, missing, nested and cross-profile references without writes", async () => {
    const foreign = await diary<{ product: { id: string } }>(
      t,
      s.token,
      "POST",
      `/profiles/${s.profileB}/products`,
      product,
    );
    const body = command();
    const cases = [
      { ...body, new_foods: [...body.new_foods, body.new_foods[1]] },
      { ...body, entries: [estimate("Dish", 1)] },
      { ...body, entries: [estimate("Dish", 1, { food_ref: "missing" })] },
      {
        ...body,
        entries: [estimate("Dish", 1, { food_ref: "oats", product_id: foreign.body.product.id })],
      },
      {
        ...body,
        new_foods: [
          {
            ...body.new_foods[0],
            definition: {
              ...body.new_foods[0]?.definition,
              ingredients: [estimate("Nested", 1, { food_ref: "porridge" })],
            },
          },
        ],
      },
      {
        diary_date: body.diary_date,
        entries: [estimate("Foreign", 1, { product_id: foreign.body.product.id })],
      },
      {
        ...body,
        new_foods: [
          {
            client_ref: "porridge",
            type: "recipe",
            definition: { name: "Incomplete", nutrients: {}, ingredients: [estimate("Food", 1)] },
          },
        ],
      },
    ];
    for (const invalid of cases) {
      const before = await savedCounts();
      expect((await diary(t, s.token, "POST", `${root()}/meals`, invalid)).status).toBe(400);
      expect(await savedCounts()).toEqual(before);
    }
  });

  it("rolls back a keyed conflict with the client reference and serializes deliberate concurrent logs", async () => {
    const body = {
      diary_date: "2026-10-20",
      entries: [estimate("Oats", 1, { food_ref: "oats" })],
      new_foods: [{ client_ref: "oats", type: "product", definition: product }],
    };
    const second = await connect(t, s.alice);
    const results = await Promise.all(
      [s.token, second.token].map((token) =>
        diary<Result>(t, token, "POST", `${root()}/meals`, body),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0]?.body.retained_foods[0]?.id).toBe(results[1]?.body.retained_foods[0]?.id);
    expect(results[0]?.body.meal.id).not.toBe(results[1]?.body.meal.id);
    const before = await savedCounts();
    const conflict = await diary(t, s.token, "POST", `${root()}/meals`, {
      ...body,
      new_foods: [
        { ...body.new_foods[0], definition: { ...product, nutrients: { energy_kcal: 1 } } },
      ],
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      code: "food_identity_conflict",
      current: { client_ref: "oats" },
    });
    expect(await savedCounts()).toEqual(before);
  });

  it("rolls back each insertion stage for new meals and append, then permits a genuine retry", async () => {
    const existing = await diary<Result>(t, s.token, "POST", `${root()}/meals`, {
      diary_date: "2026-10-20",
      entries: [estimate("Existing", 1)],
    });
    for (const append of [false, true])
      for (const table of ["products", "recipes", "entries"]) {
        const body = command();
        const oats = body.new_foods[1];
        if (!oats) throw new Error("fixture missing");
        const input = {
          ...body,
          new_foods: [body.new_foods[0], { ...oats, definition: { ...product, barcode: null } }],
        };
        const payload = append ? { entries: input.entries, new_foods: input.new_foods } : input;
        const path = append
          ? `${root()}/meals/${existing.body.meal.id}/entries`
          : `${root()}/meals`;
        const name = `fail_${randomUUID().replaceAll("-", "")}`;
        const before = await savedCounts();
        const requestId = randomUUID();
        await t.pool.query(
          `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic insertion failure'; END $$`,
        );
        await t.pool.query(
          `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW WHEN (NEW.account_id = '${s.profileA}') EXECUTE FUNCTION ${name}()`,
        );
        try {
          expect((await diary(t, s.token, "POST", path, payload, requestId)).status).toBe(500);
          expect(await savedCounts()).toEqual(before);
          expect(
            (
              await t.pool.query(
                "SELECT count(*)::int AS n FROM request_results WHERE request_id=$1",
                [requestId],
              )
            ).rows[0],
          ).toEqual({ n: 0 });
        } finally {
          await t.pool.query(`DROP TRIGGER ${name} ON ${table}`);
          await t.pool.query(`DROP FUNCTION ${name}()`);
        }
        expect((await diary(t, s.token, "POST", path, payload, requestId)).status).toBe(201);
      }
  });

  it("removes scoped cached responses when one profile is deleted from a shared connection", async () => {
    const alice = t.firebase.token(randomUUID(), "Synthetic owner");
    const bob = t.firebase.token(randomUUID(), "Synthetic second");
    const owner = await connect(t, alice);
    await join(t, owner.token, bob);
    const a = await ownProfile(t, alice);
    const b = await ownProfile(t, bob);
    const requestId = randomUUID();
    const body = { diary_date: "2026-10-20", entries: [estimate("Synthetic", 1)] };
    await diary(t, owner.token, "POST", `/profiles/${b}/meals`, body, requestId);
    await diary(t, owner.token, "POST", `/profiles/${a}/meals`, body);
    expect((await call(t, "DELETE", "/api/manage/me", { token: bob })).status).toBe(200);
    expect(
      (
        await t.pool.query("SELECT count(*)::int AS n FROM request_results WHERE account_id=$1", [
          b,
        ])
      ).rows[0],
    ).toEqual({ n: 0 });
    expect(
      (
        await t.pool.query("SELECT count(*)::int AS n FROM request_results WHERE account_id=$1", [
          a,
        ])
      ).rows[0],
    ).toEqual({ n: 1 });
    expect(
      (await diary(t, owner.token, "POST", `/profiles/${b}/meals`, body, requestId)).status,
    ).toBe(403);
  });
});
