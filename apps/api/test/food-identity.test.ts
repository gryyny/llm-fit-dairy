import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, startApp, type TestApp } from "./app.js";
import {
  connect,
  diary,
  estimate,
  setupProfiles,
  legacyProduct,
  type Setup,
} from "./diary-helpers.js";

let t: TestApp;
let s: Setup;
beforeAll(async () => {
  t = await startApp();
  s = await setupProfiles(t);
});
afterAll(async () => {
  await t.close();
});
const path = () => `/profiles/${s.profileA}/products`;
const food = {
  name: "Synthetic identity food",
  food_kind: "product",
  brand: "Synthetic",
  variant: "plain",
  barcode: "5901234123457",
  preparation: { state: "as_sold" },
  provenance: { source: "estimate" },
  basis_amount: 100,
  basis_unit: "g",
  nutrients: { energy_kcal: 200 },
};
interface Saved {
  product: {
    id: string;
    food_id: string;
    revision_id: string;
    version: number;
    identity_key: string | null;
    name: string;
  };
  outcome: string;
}

describe("exact reusable-food identity", () => {
  it("matches equivalent unit aliases while preserving the stored basis and label", async () => {
    const body = {
      ...food,
      barcode: "96385074",
      basis_unit: "г",
      provenance: {
        source: "label",
        label: { basis_amount: 100, basis_unit: "г", nutrients: { energy_kcal: 200 } },
      },
    };
    const first = await diary<Saved>(t, s.token, "POST", path(), body);
    const reused = await diary<Saved>(t, s.token, "POST", path(), {
      ...body,
      basis_unit: "g",
      provenance: { ...body.provenance, label: { ...body.provenance.label, basis_unit: "g" } },
    });
    expect(reused.status).toBe(201);
    expect(reused.body).toMatchObject({
      outcome: "reused",
      product: {
        id: first.body.product.id,
        basis_unit: "г",
        provenance: { label: { basis_unit: "г" } },
      },
    });
  });

  it("blocks duplicate creation for an unclassified barcode until an explicit versioned correction", async () => {
    const id = await legacyProduct(
      t,
      s.profileA,
      "Legacy keyed",
      "4006381333931",
      "04006381333931",
    );
    const body = { ...food, barcode: "4006381333931" };
    const collision = await diary(t, s.token, "POST", path(), body);
    expect(collision.status).toBe(409);
    expect(collision.body).toMatchObject({
      code: "food_identity_conflict",
      current: { product: { id, food_kind: null, version: 1 } },
    });
    const updated = await diary<Saved>(t, s.token, "PUT", `${path()}/${id}?version=1`, body);
    expect(updated.status).toBe(200);
    expect((await diary<Saved>(t, s.token, "POST", path(), body)).body).toMatchObject({
      outcome: "reused",
      product: { id, version: 2 },
    });
    expect(
      (await diary<Saved>(t, s.token, "POST", `/profiles/${s.profileB}/products`, body)).body
        .product.id,
    ).not.toBe(id);
  });
  it("keys the exact published record and rejects nonexistent evidence", async () => {
    const release = await t.pool.query<{ id: string }>(
      "INSERT INTO catalogue_release (source,release,archive_sha256,read_count,record_count,rejected_count,rejected_reasons) VALUES ('ciqual',$1,'synthetic',2,2,0,'{}') RETURNING id",
      [randomUUID()],
    );
    const records = await t.pool.query<{ id: number }>(
      "INSERT INTO catalogue_record (release_id,source_id,name,nutrients) VALUES ($1,'one','Synthetic oats','{}'),($1,'two','Synthetic oats','{}') RETURNING id::int",
      [release.rows[0]?.id],
    );
    const saved: string[] = [];
    for (const record of records.rows) {
      const body = {
        ...food,
        food_kind: "basic",
        barcode: null,
        preparation: { state: "as_published" },
        provenance: { source: "dataset", catalogue_record_id: record.id },
      };
      const first = await diary<Saved>(t, s.token, "POST", path(), body);
      const second = await diary<Saved>(t, s.token, "POST", path(), body);
      expect(first.status).toBe(201);
      expect(first.body.product.identity_key).toBe(`catalogue:${record.id}`);
      expect(second.body.product.id).toBe(first.body.product.id);
      saved.push(first.body.product.id);
    }
    expect(new Set(saved).size).toBe(2);
    expect(
      (
        await diary(t, s.token, "POST", path(), {
          ...food,
          provenance: { source: "dataset", catalogue_record_id: Number.MAX_SAFE_INTEGER },
        })
      ).status,
    ).toBe(400);
  });
  it("serializes different connections and preserves the original name on reuse", async () => {
    const second = await connect(t, s.alice);
    const results = await Promise.all(
      [s.token, second.token].map((token) => diary<Saved>(t, token, "POST", path(), food)),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0]?.body.product.id).toBe(results[1]?.body.product.id);
    expect(results.map((r) => r.body.outcome).sort()).toEqual(["created", "reused"]);
    const reused = await diary<Saved>(t, s.token, "POST", path(), {
      ...food,
      name: "Another display name",
      barcode: "05901234123457",
    });
    expect(reused.body.product).toMatchObject({
      id: results[0]?.body.product.id,
      version: 1,
      name: food.name,
      identity_key: "gtin:05901234123457",
    });
    const other = await diary<Saved>(t, s.token, "POST", `/profiles/${s.profileB}/products`, food);
    expect(other.body.product.id).not.toBe(reused.body.product.id);
  });

  it("rejects conflicting evidence, variants, bases and unknown versus zero without overwriting", async () => {
    const saved = await diary<Saved>(t, s.token, "POST", path(), food);
    for (const change of [
      { variant: "sweet" },
      { basis_amount: 50 },
      { nutrients: { energy_kcal: 200, salt_g: 0 } },
      {
        provenance: {
          source: "label",
          label: { basis_amount: 100, basis_unit: "g", nutrients: { energy_kcal: 200 } },
        },
      },
    ]) {
      const conflict = await diary(t, s.token, "POST", path(), { ...food, ...change });
      expect(conflict.status).toBe(409);
      expect(conflict.body).toMatchObject({
        code: "food_identity_conflict",
        current: { product: { id: saved.body.product.id, version: 1 } },
      });
    }
    const updated = await diary<Saved>(
      t,
      s.token,
      "PUT",
      `${path()}/${saved.body.product.id}?version=1`,
      { ...food, nutrients: { energy_kcal: 201 } },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.product.version).toBe(2);
  });

  it("leaves unspecified preparation and invalid/restricted barcodes unkeyed", async () => {
    for (const body of [
      { ...food, preparation: { state: "unspecified" } },
      { ...food, barcode: "not-a-code" },
      { ...food, barcode: "2000000000015" },
    ]) {
      const a = await diary<Saved>(t, s.token, "POST", path(), body);
      const b = await diary<Saved>(t, s.token, "POST", path(), body);
      expect(a.status).toBe(201);
      expect(a.body.product.identity_key).toBeNull();
      expect(b.body.product.id).not.toBe(a.body.product.id);
    }
    expect(
      (await diary(t, s.token, "POST", path(), { ...food, preparation: { state: "other" } }))
        .status,
    ).toBe(400);
  });

  it("allows a migrated unknown row to acquire metadata without merging another row", async () => {
    const id = await legacyProduct(t, s.profileA, "Legacy synthetic");
    const read = await diary<Saved>(t, s.token, "GET", `${path()}/${id}`);
    expect(read.body.product).toMatchObject({ identity_key: null });
    const collision = await diary(t, s.token, "PUT", `${path()}/${id}?version=1`, food);
    expect(collision.status).toBe(409);
    const changed = await diary<Saved>(t, s.token, "PUT", `${path()}/${id}?version=1`, {
      ...food,
      preparation: { state: "other", description: "Cooked" },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.product).toMatchObject({ id, version: 2, identity_key: null });
  });

  it("preserves an explicit correction of an unkeyed barcode as a new revision", async () => {
    const body = { ...food, barcode: "synthetic-old-code" };
    const first = await diary<Saved>(t, s.token, "POST", path(), body);
    const changed = await diary<Saved>(
      t,
      s.token,
      "PUT",
      `${path()}/${first.body.product.id}?version=1`,
      {
        ...body,
        barcode: "synthetic-new-code",
      },
    );
    expect(changed.status).toBe(200);
    expect(changed.body.product).toMatchObject({
      food_id: first.body.product.food_id,
      barcode: "synthetic-new-code",
      identity_key: null,
    });
    expect(changed.body.product.revision_id).not.toBe(first.body.product.revision_id);
  });
});

describe("shared definitions and private links", () => {
  it("converges concurrent profiles, retains conflicting revisions and never shares private fields", async () => {
    const people = await setupProfiles(t);
    const root = (id: string) => `/profiles/${id}`;
    const release = await t.pool.query<{ id: string }>(
      "INSERT INTO catalogue_release (source,release,archive_sha256,read_count,record_count,rejected_count,rejected_reasons) VALUES ('ciqual',$1,'synthetic',1,1,0,'{}') RETURNING id",
      [randomUUID()],
    );
    const record = await t.pool.query<{ id: number }>(
      "INSERT INTO catalogue_record (release_id,source_id,name,nutrients) VALUES ($1,'one','Synthetic published food','{\"energy_kcal\":200}') RETURNING id::int",
      [release.rows[0]?.id],
    );
    const recordId = record.rows[0]?.id;
    const evidence = (await t.pool.query("SELECT * FROM catalogue_record WHERE id=$1", [recordId]))
      .rows;
    const definition = {
      ...food,
      barcode: null,
      food_kind: "basic",
      preparation: { state: "as_published" },
      provenance: { source: "dataset", catalogue_record_id: recordId },
    };
    const results = await Promise.all(
      [people.profileA, people.profileB].map((id, n) =>
        diary<Saved>(t, people.token, "POST", `${root(id)}/products`, {
          ...definition,
          name: `Private name ${n}`,
          note: `Private note ${n}`,
          recognition_description: `Private description ${n}`,
          preferred_record_ids: n === 0 ? [recordId] : [],
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const a = results[0]?.body.product;
    const b = results[1]?.body.product;
    if (!a || !b) throw new Error("missing concurrent product results");
    expect(a.id).not.toBe(b.id);
    expect(a.food_id).toBe(b.food_id);
    expect(a.revision_id).toBe(b.revision_id);
    expect(b).toMatchObject({
      name: "Private name 1",
      note: "Private note 1",
      preferred_record_ids: [],
    });
    const shared = (
      await t.pool.query("SELECT content FROM food_revisions WHERE food_id=$1", [a.food_id])
    ).rows;
    expect(JSON.stringify(shared)).not.toContain("Private");
    const counts = (
      await t.pool.query("SELECT count(*)::int AS count FROM food_revisions WHERE food_id=$1", [
        a.food_id,
      ])
    ).rows;
    expect(counts).toEqual([{ count: 1 }]);
    const stranger = await diary<Saved>(
      t,
      people.carolToken,
      "POST",
      `${root(people.carolProfile)}/products`,
      definition,
    );
    expect(stranger.body.product.food_id).toBe(a.food_id);
    expect(
      (await diary(t, people.carolToken, "GET", `${root(people.profileA)}/products/${a.id}`))
        .status,
    ).toBe(403);
    expect(
      (
        await diary(t, people.carolToken, "POST", `${root(people.carolProfile)}/foods/link`, {
          source_profile_id: people.profileA,
          record_type: "products",
          record_id: a.id,
          name: "Forbidden",
        })
      ).status,
    ).toBe(403);
    const discovered = await diary<{ items: { source_profile_id: string }[] }>(
      t,
      people.carolToken,
      "GET",
      `${root(people.carolProfile)}/foods?scope=connection`,
    );
    expect(discovered.body.items.map((i) => i.source_profile_id)).toEqual([people.carolProfile]);
    expect(JSON.stringify(discovered.body)).not.toContain("Private");
    expect(
      (
        await call(t, "GET", `/api/v1${root(people.profileA)}/foods?scope=connection`, {
          token: people.alice,
        })
      ).status,
    ).toBe(400);
    const logged = await diary<{ meal: { id: string; entries: { food_revision_id: string }[] } }>(
      t,
      people.token,
      "POST",
      `${root(people.profileA)}/meals`,
      {
        diary_date: "2026-10-20",
        entries: [estimate("Synthetic portion", 100, { product_id: a.id })],
      },
    );
    expect(logged.status).toBe(201);
    const changed = await diary<Saved>(
      t,
      people.token,
      "PUT",
      `${root(people.profileA)}/products/${a.id}?version=1`,
      {
        ...definition,
        nutrients: { energy_kcal: 201 },
        note: "Private correction",
      },
    );
    expect(changed.status).toBe(200);
    expect(changed.body.product.food_id).toBe(a.food_id);
    expect(changed.body.product.revision_id).not.toBe(a.revision_id);
    expect(
      (await diary<Saved>(t, people.token, "GET", `${root(people.profileB)}/products/${b.id}`)).body
        .product,
    ).toMatchObject({
      revision_id: b.revision_id,
      nutrients: { energy_kcal: 200 },
      note: "Private note 1",
      version: 1,
    });
    expect(
      (
        await t.pool.query("SELECT nutrients,food_revision_id FROM entries WHERE meal_id=$1", [
          logged.body.meal.id,
        ])
      ).rows,
    ).toEqual([{ nutrients: { energy_kcal: 100 }, food_revision_id: a.revision_id }]);
    expect(
      (await t.pool.query("SELECT * FROM catalogue_record WHERE id=$1", [recordId])).rows,
    ).toEqual(evidence);
    const conflict = await diary(t, people.token, "POST", `${root(people.profileB)}/foods/link`, {
      source_profile_id: people.profileA,
      record_type: "products",
      record_id: a.id,
      name: "Another revision",
    });
    expect(conflict.status).toBe(409);
    expect(JSON.stringify(conflict.body)).not.toContain("Private correction");
  });

  it("links one recipe and its ingredients atomically, preserves revisions after deletion and collects only unused facts", async () => {
    const people = await setupProfiles(t);
    const a = `/profiles/${people.profileA}`;
    const b = `/profiles/${people.profileB}`;
    const first = await diary<{
      meal: { id: string };
      retained_foods: { id: string; food_id: string; revision_id: string }[];
    }>(t, people.token, "POST", `${a}/meals`, {
      diary_date: "2026-10-21",
      entries: [estimate("Synthetic soup", 200, { food_ref: "soup" })],
      new_foods: [
        {
          type: "product",
          client_ref: "veg",
          definition: { ...food, barcode: null, note: "Private ingredient note" },
        },
        {
          type: "recipe",
          client_ref: "soup",
          definition: {
            name: "Synthetic soup",
            servings: 2,
            nutrients: { energy_kcal: 400 },
            note: "Private recipe note",
            recognition_description: "Private recipe description",
            ingredients: [
              estimate("Synthetic vegetable", 400, {
                food_ref: "veg",
                note: "Private preparation",
              }),
            ],
          },
        },
      ],
    });
    expect(first.status).toBe(201);
    const product = first.body.retained_foods[0];
    const recipe = first.body.retained_foods[1];
    if (!product || !recipe) throw new Error("missing retained foods");
    const requestId = randomUUID();
    const body = {
      diary_date: "2026-10-21",
      entries: [estimate("My soup", 200, { food_ref: "shared" })],
      new_foods: [
        {
          type: "link",
          client_ref: "shared",
          definition: {
            source_profile_id: people.profileA,
            record_type: "recipes",
            record_id: recipe.id,
            name: "My soup",
          },
        },
      ],
    };
    const [linked, retry] = await Promise.all(
      [1, 2].map(() =>
        diary<{
          meal: { id: string; entries: { recipe_id: string; food_revision_id: string }[] };
          retained_foods: { id: string; food_id: string; revision_id: string }[];
        }>(t, people.token, "POST", `${b}/meals`, body, requestId),
      ),
    );
    if (!linked || !retry) throw new Error("missing replay results");
    expect(linked.status).toBe(201);
    expect(retry.body).toEqual(linked.body);
    const retained = linked.body.retained_foods[0];
    if (!retained) throw new Error("missing linked food");
    expect(retained).toMatchObject({ food_id: recipe.food_id, revision_id: recipe.revision_id });
    expect(retained.id).not.toBe(recipe.id);
    interface Recipe {
      id: string;
      version: number;
      name: string;
      note: string | null;
      recognition_description: string | null;
      ingredients: {
        id: string;
        name: string;
        note: string;
        product_id: string | null;
        food_revision_id: string | null;
      }[];
    }
    const read = await diary<{ recipe: Recipe }>(
      t,
      people.token,
      "GET",
      `${b}/recipes/${retained.id}`,
    );
    expect(read.body.recipe).toMatchObject({
      note: null,
      recognition_description: null,
      ingredients: [{ note: "", food_revision_id: product.revision_id }],
    });
    expect(typeof read.body.recipe.ingredients[0]?.product_id).toBe("string");
    expect(JSON.stringify(read.body)).not.toContain("Private");
    const ingredients = (
      await t.pool.query("SELECT * FROM recipe_ingredients WHERE recipe_revision_id=$1", [
        recipe.revision_id,
      ])
    ).rows;
    expect(ingredients).toHaveLength(1);
    expect(JSON.stringify(ingredients)).not.toContain("Private");
    expect((await call(t, "DELETE", "/api/manage/me", { token: people.alice })).status).toBe(200);
    const bob = await connect(t, people.bob);
    const still = await diary<{ recipe: Recipe }>(
      t,
      bob.token,
      "GET",
      `${b}/recipes/${retained.id}`,
    );
    expect(still.body.recipe).toEqual(read.body.recipe);
    const ingredient = still.body.recipe.ingredients[0];
    if (!ingredient?.product_id) throw new Error("missing retained ingredient link");
    expect(
      (await diary(t, bob.token, "DELETE", `${b}/products/${ingredient.product_id}?version=1`))
        .status,
    ).toBe(200);
    expect(
      (await t.pool.query("SELECT id FROM food_revisions WHERE id=$1", [product.revision_id])).rows,
    ).toHaveLength(1);
    const amended = await diary<{ recipe: Recipe }>(
      t,
      bob.token,
      "PUT",
      `${b}/recipes/${retained.id}?version=1`,
      {
        name: "My renamed soup",
        servings: 2,
        nutrients: { energy_kcal: 400 },
        note: "My note",
        ingredients: [
          {
            name: ingredient.name,
            quantity: 1,
            unit: "serving",
            nutrients: { energy_kcal: 400 },
            source: "estimate",
            note: "My preparation",
          },
        ],
      },
    );
    expect(amended.status).toBe(200);
    expect(amended.body.recipe.ingredients[0]).toMatchObject({
      product_id: null,
      food_revision_id: product.revision_id,
    });
    expect(
      (await diary(t, bob.token, "DELETE", `${b}/recipes/${retained.id}?version=2`)).status,
    ).toBe(200);
    expect(
      (await t.pool.query("SELECT id FROM food_revisions WHERE id=$1", [recipe.revision_id])).rows,
    ).toHaveLength(1);
    expect((await call(t, "DELETE", "/api/manage/me", { token: people.bob })).status).toBe(200);
    expect(
      (
        await t.pool.query("SELECT id FROM food_definitions WHERE id IN ($1,$2)", [
          product.food_id,
          recipe.food_id,
        ])
      ).rows,
    ).toEqual([]);
  });

  it("requires retention, accepts only the two diary exceptions and rolls back failed shared links", async () => {
    const people = await setupProfiles(t);
    const a = `/profiles/${people.profileA}`;
    const base = {
      name: "Synthetic dish",
      quantity: 1,
      unit: "portion",
      nutrients: {},
      source: "estimate",
      note: "Synthetic",
    };
    const before = (await t.pool.query("SELECT count(*)::int AS count FROM food_definitions")).rows;
    for (const entry of [
      base,
      { ...base, diary_only_reason: "not_saving" },
      { ...base, diary_only_reason: "one_off_restaurant", food_ref: "p" },
    ]) {
      expect(
        (
          await diary(t, people.token, "POST", `${a}/meals`, {
            diary_date: "2026-10-22",
            entries: [entry],
          })
        ).status,
      ).toBe(400);
    }
    for (const reason of ["one_off_restaurant", "insufficient_recipe_details"]) {
      const saved = await diary(t, people.token, "POST", `${a}/meals`, {
        diary_date: "2026-10-22",
        entries: [{ ...base, diary_only_reason: reason }],
      });
      expect(saved.status).toBe(201);
      expect(saved.body).toMatchObject({
        meal: { entries: [{ diary_only_reason: reason, food_revision_id: null }] },
      });
    }
    const failed = await diary(t, people.token, "POST", `${a}/meals`, {
      diary_date: "2026-10-22",
      entries: [
        estimate("Product", 200, { food_ref: "p" }),
        estimate("Forbidden", 200, { food_ref: "link" }),
      ],
      new_foods: [
        { type: "product", client_ref: "p", definition: { ...food, barcode: null } },
        {
          type: "link",
          client_ref: "link",
          definition: {
            source_profile_id: people.carolProfile,
            record_type: "products",
            record_id: randomUUID(),
            name: "Forbidden",
          },
        },
      ],
    });
    expect(failed.status).toBe(403);
    expect(
      (await t.pool.query("SELECT count(*)::int AS count FROM food_definitions")).rows,
    ).toEqual(before);
    expect(
      (await t.pool.query("SELECT id FROM products WHERE account_id=$1", [people.profileA])).rows,
    ).toEqual([]);
  });
});
