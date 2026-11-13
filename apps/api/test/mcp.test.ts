import {
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, CLIENT, startApp, type TestApp } from "./app.js";
import { connect, ownProfile, setupProfiles } from "./diary-helpers.js";
import { connectCookie, decide } from "./oauth-flow.js";

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

let t: TestApp;
let issuer: string;

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (typeof address !== "object" || address === null) throw new Error("no port");
  return address.port;
}

beforeAll(async () => {
  const port = await freePort();
  issuer = `http://127.0.0.1:${String(port)}`;
  t = await startApp({ issuer }, port);
});
afterAll(() => t.close());

/** The SDK's OAuth client acting as ChatGPT: the provided client, PKCE and stored tokens. */
class ChatGptStandIn implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  private verifier = "";
  private saved: StoredOAuthTokens | undefined;

  get redirectUrl() {
    return CLIENT.redirectUri;
  }
  get clientMetadata() {
    return { redirect_uris: [CLIENT.redirectUri], client_name: "ChatGPT stand-in" };
  }
  clientInformation() {
    return { client_id: CLIENT.id, client_secret: CLIENT.secret };
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

const transportFor = (provider: OAuthClientProvider) =>
  new StreamableHTTPClientTransport(new URL(`${issuer}/mcp`), { authProvider: provider });

/** Connects like ChatGPT: a 401 starts discovery and authorization, the person approves, then the code is exchanged. */
async function connectedClient(firebaseToken: string): Promise<Client> {
  const provider = new ChatGptStandIn();
  const first = transportFor(provider);
  await expect(new Client({ name: "test", version: "1" }).connect(first)).rejects.toThrow();
  const authorizationUrl = provider.authorizationUrl;
  if (!authorizationUrl) throw new Error("the client did not start authorization");
  expect(authorizationUrl.searchParams.get("resource")).toBe(`${issuer}/mcp`);
  const started = await fetch(authorizationUrl, { redirect: "manual" });
  const decided = await decide(t, firebaseToken, connectCookie(started));
  await first.finishAuth(new URL(decided.body.redirect_to).searchParams);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transportFor(provider));
  return client;
}

const callTool = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

const containsKey = (value: unknown, key: string): boolean =>
  typeof value === "object" &&
  value !== null &&
  (key in value || Object.values(value).some((v) => containsKey(v, key)));

describe("MCP over OAuth (MC-1, MC-2; local stand-in, not ChatGPT evidence)", () => {
  let alice: Client;

  beforeAll(async () => {
    alice = await connectedClient(t.firebase.token(`alice-${randomUUID()}`, "Synthetic Alice"));
  });
  afterAll(() => alice.close());

  it("lists every tool with explicit annotations and OAuth security schemes", async () => {
    const { tools } = await alice.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "add_profile",
        "delete_record",
        "link_food",
        "list_profiles",
        "list_saved",
        "read_catalogue_record",
        "read_diary",
        "read_food",
        "read_profile",
        "save_meal",
        "save_product",
        "save_recipe",
        "save_target",
        "save_weight",
        "search_catalogue",
        "search_diary",
        "select_day_target",
        "set_food_link",
        "update_entry",
        "update_body_context",
        "update_meal",
        "update_product",
        "update_profile",
        "update_recipe",
        "update_target",
        "update_weight",
      ].sort(),
    );
    expect(tools.find((tool) => tool.name === "update_body_context")?.inputSchema).toMatchObject({
      properties: { changes: { properties: { date_of_birth: {} } } },
    });
    const names = (pick: (a: Record<string, unknown>) => boolean) =>
      tools
        .filter((tool) => pick(tool.annotations ?? {}))
        .map((tool) => tool.name)
        .sort();
    expect(names((a) => a.readOnlyHint === true)).toEqual(
      [
        "list_profiles",
        "list_saved",
        "read_catalogue_record",
        "read_diary",
        "read_food",
        "read_profile",
        "search_catalogue",
        "search_diary",
      ].sort(),
    );
    expect(names((a) => a.destructiveHint === true)).toEqual(
      [
        "delete_record",
        "select_day_target",
        "set_food_link",
        "update_entry",
        "update_body_context",
        "update_meal",
        "update_product",
        "update_profile",
        "update_recipe",
        "update_target",
        "update_weight",
      ].sort(),
    );
    for (const tool of tools) {
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) {
        expect(typeof tool.annotations?.[hint as "readOnlyHint"]).toBe("boolean");
      }
      expect(tool._meta).toEqual({ securitySchemes: [{ type: "oauth2", scopes: ["diary"] }] });
    }
  });

  it("uses the only profile automatically, and asks for one after another person joins", async () => {
    const saved = await callTool(alice, "save_meal", {
      request_id: randomUUID(),
      diary_date: "2026-08-01",
      label: "Breakfast",
      entries: [
        {
          name: "Porridge",
          diary_only_reason: "insufficient_recipe_details",
          quantity: 1,
          unit: "bowl",
          nutrients: { energy_kcal: 300 },
          source: "estimate",
          note: "synthetic",
        },
      ],
    });
    expect(saved.isError).toBeFalsy();
    expect(saved.structuredContent?.profile_used).toMatchObject({ name: "Synthetic Alice" });
    const read = await callTool(alice, "read_diary", { from: "2026-08-01", to: "2026-08-01" });
    expect(JSON.stringify(read.structuredContent)).toContain("Porridge");
    expect(containsKey(read.structuredContent, "created_at")).toBe(false);

    const invite = await callTool(alice, "add_profile", { request_id: randomUUID() });
    const joinUrl = new URL((invite.structuredContent?.invite as { join_url: string }).join_url);
    expect(`${joinUrl.origin}${joinUrl.pathname}`).toBe(`${issuer}/join`);
    const sam = t.firebase.token(`sam-${randomUUID()}`, "Synthetic Sam");
    await call(t, "POST", "/api/manage/join", {
      token: sam,
      body: { code: joinUrl.searchParams.get("code"), approve: true, consent: true },
    });
    const ambiguous = await callTool(alice, "save_weight", {
      request_id: randomUUID(),
      date: "2026-08-01",
      value: 70,
      unit: "kg",
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.structuredContent).toMatchObject({ code: "profile_required" });
    expect((ambiguous.structuredContent?.profiles as unknown[]).length).toBe(2);
    const named = await callTool(alice, "save_weight", {
      profile_id: await ownProfile(t, sam),
      request_id: randomUUID(),
      date: "2026-08-01",
      value: 70,
      unit: "kg",
    });
    expect(named.isError).toBeFalsy();
  });

  it("replays a retried write instead of saving it twice, and replaces through update tools", async () => {
    const listed = await callTool(alice, "list_profiles");
    const profileId = (
      listed.structuredContent?.items as { profile_id: string; name: string }[]
    ).find((p) => p.name === "Synthetic Alice")?.profile_id;
    const args = {
      profile_id: profileId,
      request_id: randomUUID(),
      name: "Synthetic oats",
      food_kind: "basic",
      preparation: { state: "unspecified" },
      provenance: { source: "estimate" },
      basis_amount: 100,
      basis_unit: "g",
      nutrients: { energy_kcal: 370 },
    };
    const first = await callTool(alice, "save_product", args);
    const retry = await callTool(alice, "save_product", args);
    const product = first.structuredContent?.product as { id: string; version: number };
    expect((retry.structuredContent?.product as { id: string }).id).toBe(product.id);
    const products = await callTool(alice, "list_saved", {
      profile_id: profileId,
      record_type: "products",
    });
    expect((products.structuredContent?.items as unknown[]).length).toBe(1);

    const updated = await callTool(alice, "update_product", {
      ...args,
      request_id: randomUUID(),
      product_id: product.id,
      version: product.version,
      nutrients: { energy_kcal: 380 },
    });
    expect(updated.structuredContent?.product).toMatchObject({ nutrients: { energy_kcal: 380 } });
    const mealArgs = {
      profile_id: profileId,
      request_id: randomUUID(),
      diary_date: "2026-08-01",
      entries: [
        {
          name: "Synthetic toast",
          quantity: 1,
          unit: "slice",
          nutrients: { energy_kcal: 80 },
          source: "estimate",
          note: "synthetic",
          food_ref: "toast",
        },
      ],
      new_foods: [
        {
          client_ref: "toast",
          type: "product",
          definition: {
            name: "Synthetic toast",
            food_kind: "basic",
            preparation: { state: "unspecified" },
            provenance: { source: "estimate" },
            basis_amount: 1,
            basis_unit: "slice",
            nutrients: { energy_kcal: 80 },
          },
        },
      ],
    };
    const logged = await callTool(alice, "save_meal", mealArgs);
    expect(logged.isError).toBeFalsy();
    const meal = logged.structuredContent?.meal as { id: string };
    expect(logged.structuredContent?.retained_foods).toMatchObject([
      { client_ref: "toast", outcome: "created" },
    ]);
    const appended = await callTool(alice, "save_meal", {
      ...mealArgs,
      request_id: randomUUID(),
      meal_id: meal.id,
      diary_date: undefined,
    });
    expect(appended.isError).toBeFalsy();
    expect(appended.structuredContent?.retained_foods).toMatchObject([
      { client_ref: "toast", outcome: "created" },
    ]);
    expect(appended.structuredContent?.created_entry_ids).toHaveLength(1);
    const profileRead = await callTool(alice, "read_profile", { profile_id: profileId });
    expect(profileRead.structuredContent?.body_context).toBeNull();
    const profile = profileRead.structuredContent?.profile as { version: number };
    const bodySaved = await callTool(alice, "update_body_context", {
      profile_id: profileId,
      request_id: randomUUID(),
      version: 0,
      changes: { height: { value: 180, unit: "cm" } },
    });
    expect(bodySaved.isError).toBeFalsy();
    expect(bodySaved.structuredContent?.body_context).toMatchObject({
      height: { value: 180, unit: "cm" },
      version: 1,
    });
    const renamed = await callTool(alice, "update_profile", {
      profile_id: profileId,
      request_id: randomUUID(),
      version: profile.version,
      name: "Synthetic renamed",
    });
    expect(renamed.structuredContent?.profile).toMatchObject({
      name: "Synthetic renamed",
      version: profile.version + 1,
    });
  });

  it("persists partial body changes across MCP sessions and website reads without changing history", async () => {
    const owner = t.firebase.token(`body-${randomUUID()}`, "Synthetic body owner");
    const profileId = await ownProfile(t, owner);
    const client = await connectedClient(owner);
    const stranger = await connectedClient(t.firebase.token(`body-other-${randomUUID()}`));
    try {
      const args = { profile_id: profileId };
      expect(
        (await callTool(client, "read_profile", args)).structuredContent?.body_context,
      ).toBeNull();
      expect(
        (
          await callTool(client, "save_weight", {
            ...args,
            request_id: randomUUID(),
            date: "2026-10-01",
            value: 82,
            unit: "kg",
            note: "Synthetic height was mentioned here; this is not canonical body data.",
          })
        ).isError,
      ).toBeFalsy();
      expect(
        (
          await callTool(client, "save_target", {
            ...args,
            request_id: randomUUID(),
            kind: "normal",
            effective_from: "2026-10-01",
            values: { energy_kcal: { value: 2100 } },
          })
        ).isError,
      ).toBeFalsy();
      const weights = (await t.pool.query("SELECT * FROM weights WHERE account_id=$1", [profileId]))
        .rows;
      const targets = (await t.pool.query("SELECT * FROM targets WHERE account_id=$1", [profileId]))
        .rows;
      const fields = {
        height: { value: 178, unit: "cm" },
        date_of_birth: "1988-02-29",
        activity: "Synthetic walking",
        goal: "Synthetic maintenance",
      };
      const create = { ...args, request_id: randomUUID(), version: 0, changes: fields };
      const saved = await callTool(client, "update_body_context", create);
      expect(saved.isError).toBeFalsy();
      expect(saved.structuredContent?.body_context).toEqual({ ...fields, age: null, version: 1 });
      expect(await callTool(client, "update_body_context", create)).toEqual(saved);
      expect(
        (
          await t.pool.query(
            "SELECT date_of_birth::text, height, activity, goal, version FROM body_contexts WHERE account_id=$1",
            [profileId],
          )
        ).rows,
      ).toEqual([{ ...fields, date_of_birth: fields.date_of_birth, version: 1 }]);
      const patch = {
        ...args,
        request_id: randomUUID(),
        version: 1,
        changes: { activity: "Synthetic cycling" },
      };
      const updated = await callTool(client, "update_body_context", patch);
      expect(updated.structuredContent?.body_context).toEqual({
        ...fields,
        age: null,
        activity: "Synthetic cycling",
        version: 2,
      });
      expect(await callTool(client, "update_body_context", patch)).toEqual(updated);
      expect(
        (await callTool(client, "update_body_context", { ...create, request_id: randomUUID() }))
          .structuredContent,
      ).toMatchObject({ code: "version_conflict" });
      for (const date_of_birth of [
        "2023-02-29",
        "not-a-date",
        "9999-01-01",
        new Date().toISOString().slice(0, 10),
      ]) {
        expect(
          (
            await callTool(client, "update_body_context", {
              ...args,
              request_id: randomUUID(),
              version: 2,
              changes: { date_of_birth },
            })
          ).isError,
        ).toBe(true);
      }
      for (const name of ["read_profile", "update_body_context"]) {
        const refused = await callTool(
          stranger,
          name,
          name === "read_profile" ? args : { ...patch, request_id: randomUUID() },
        );
        expect(refused.isError).toBe(true);
        expect(refused.structuredContent).toMatchObject({ code: "profile_not_available" });
      }
      const nextSession = await connectedClient(owner);
      try {
        const reread = await callTool(nextSession, "read_profile", args);
        expect(reread.structuredContent?.body_context).toEqual(
          updated.structuredContent?.body_context,
        );
        const website = await call(t, "GET", `/api/v1/profiles/${profileId}`, { token: owner });
        expect(website.status).toBe(200);
        expect(website.body).toEqual(reread.structuredContent);
        expect(
          (
            await call(t, "PATCH", `/api/v1/profiles/${profileId}/body-context?version=2`, {
              token: owner,
              body: { goal: "website write" },
              headers: { "Idempotency-Key": randomUUID() },
            })
          ).status,
        ).toBe(403);
        const cleared = await callTool(nextSession, "update_body_context", {
          ...args,
          request_id: randomUUID(),
          version: 2,
          changes: { date_of_birth: null },
        });
        expect(cleared.structuredContent?.body_context).toEqual({
          ...fields,
          age: null,
          date_of_birth: null,
          activity: "Synthetic cycling",
          version: 3,
        });
      } finally {
        await nextSession.close();
      }
      expect(
        (await t.pool.query("SELECT * FROM weights WHERE account_id=$1", [profileId])).rows,
      ).toEqual(weights);
      expect(
        (await t.pool.query("SELECT * FROM targets WHERE account_id=$1", [profileId])).rows,
      ).toEqual(targets);
    } finally {
      await client.close();
      await stranger.close();
    }
  });

  it("persists partial recipes through atomic MCP logging, replay, fresh sessions and website reads", async () => {
    const owner = t.firebase.token(`recipe-${randomUUID()}`, "Synthetic recipe owner");
    const profileId = await ownProfile(t, owner);
    const client = await connectedClient(owner);
    const stranger = await connectedClient(t.firebase.token(`recipe-other-${randomUUID()}`));
    const item = {
      name: "Synthetic ingredient",
      quantity: 100,
      unit: "g",
      nutrients: { energy_kcal: 100 },
      source: "estimate",
      note: "Synthetic",
    };
    const definition = {
      name: "Synthetic partial recipe",
      yield_amount: 1000,
      yield_unit: "g",
      nutrients: { energy_kcal: 500, fibre_g: 10 },
      partial_nutrients: ["fibre_g"],
      ingredients: [
        { ...item, nutrients: { energy_kcal: 400, fibre_g: 10 }, food_ref: "grain" },
        { ...item, food_ref: "other" },
      ],
    };
    const args = {
      profile_id: profileId,
      request_id: randomUUID(),
      diary_date: "2026-08-02",
      entries: [
        {
          ...item,
          name: "Synthetic recipe portion",
          quantity: 300,
          nutrients: { energy_kcal: 150, fibre_g: 3 },
          food_ref: "recipe",
        },
      ],
      new_foods: [
        {
          client_ref: "grain",
          type: "product",
          definition: {
            name: "Synthetic grain",
            food_kind: "basic",
            preparation: { state: "unspecified" },
            provenance: { source: "estimate" },
            basis_amount: 100,
            basis_unit: "g",
            nutrients: { energy_kcal: 400, fibre_g: 10 },
          },
        },
        {
          client_ref: "other",
          type: "product",
          definition: {
            name: "Synthetic other",
            food_kind: "basic",
            preparation: { state: "unspecified" },
            provenance: { source: "estimate" },
            basis_amount: 100,
            basis_unit: "g",
            nutrients: { energy_kcal: 100 },
          },
        },
        { client_ref: "recipe", type: "recipe", definition },
      ],
    };
    try {
      const tools = await client.listTools();
      expect(
        containsKey(
          tools.tools.find((tool) => tool.name === "save_meal")?.inputSchema,
          "partial_nutrients",
        ),
      ).toBe(true);
      const invalid = await callTool(client, "save_recipe", {
        profile_id: profileId,
        request_id: randomUUID(),
        ...definition,
        ingredients: [{ ...item, nutrients: { energy_kcal: 400, fibre_g: 10 } }, item],
        partial_nutrients: [],
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toMatchObject({ code: "invalid_input" });
      const saved = await callTool(client, "save_meal", args);
      expect(saved.isError).toBeFalsy();
      expect(await callTool(client, "save_meal", args)).toEqual(saved);
      const meal = saved.structuredContent?.meal as {
        id: string;
        entries: { id: string; recipe_id: string; version: number }[];
      };
      expect(meal.entries[0]).toMatchObject({
        nutrients: { energy_kcal: 150, fibre_g: 3 },
        partial_nutrients: ["fibre_g"],
      });
      const recipeId = meal.entries[0]?.recipe_id;
      expect(
        (
          await t.pool.query("SELECT nutrients,partial_nutrients FROM entries WHERE meal_id=$1", [
            meal.id,
          ])
        ).rows,
      ).toEqual([{ nutrients: { energy_kcal: 150, fibre_g: 3 }, partial_nutrients: ["fibre_g"] }]);
      const fresh = await connectedClient(owner);
      try {
        const read = await callTool(fresh, "read_food", {
          record_type: "recipes",
          record_id: recipeId,
        });
        expect(read.structuredContent?.recipe).toMatchObject({
          partial_nutrients: ["fibre_g"],
        });
        const savedRecipe = read.structuredContent?.recipe as {
          ingredients: { product_id: string | null }[];
        };
        expect(typeof savedRecipe.ingredients[0]?.product_id).toBe("string");
        expect(typeof savedRecipe.ingredients[1]?.product_id).toBe("string");
        const again = await callTool(fresh, "save_meal", {
          profile_id: profileId,
          request_id: randomUUID(),
          diary_date: "2026-08-03",
          entries: [{ ...item, recipe_id: recipeId, nutrients: { energy_kcal: 100, fibre_g: 2 } }],
        });
        expect(again.structuredContent?.meal).toMatchObject({
          entries: [{ partial_nutrients: ["fibre_g"] }],
        });
      } finally {
        await fresh.close();
      }
      const website = await call(
        t,
        "GET",
        `/api/v1/profiles/${profileId}/diary?from=2026-08-02&to=2026-08-02`,
        { token: owner },
      );
      expect(website.body).toMatchObject({
        days: [{ meals: [{ entries: [{ partial_nutrients: ["fibre_g"] }] }] }],
      });
      expect(
        (
          await callTool(stranger, "read_food", {
            profile_id: profileId,
            record_type: "recipes",
            record_id: recipeId,
          })
        ).isError,
      ).toBe(true);
      const entry = meal.entries[0];
      const bad = await callTool(client, "update_entry", {
        profile_id: profileId,
        request_id: randomUUID(),
        entry_id: entry?.id,
        version: entry?.version,
        changes: { partial_nutrients: ["salt_g"] },
      });
      expect(bad.isError).toBe(true);
      const changed = await callTool(client, "update_entry", {
        profile_id: profileId,
        request_id: randomUUID(),
        entry_id: entry?.id,
        version: entry?.version,
        changes: { note: "Synthetic correction" },
      });
      expect(changed.structuredContent?.entry).toMatchObject({ partial_nutrients: ["fibre_g"] });
    } finally {
      await client.close();
      await stranger.close();
    }
  });

  it("exposes authorized shared lookup and linking through MCP and a fresh session", async () => {
    const p = await setupProfiles(t);
    const client = new Client({ name: "shared-food-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${issuer}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${p.token}` } },
      }),
    );
    try {
      const saved = await callTool(client, "save_product", {
        profile_id: p.profileA,
        request_id: randomUUID(),
        name: "Synthetic azeite",
        food_kind: "product",
        preparation: { state: "unspecified" },
        provenance: { source: "estimate" },
        basis_amount: 100,
        basis_unit: "ml",
        nutrients: { energy_kcal: 800 },
        note: "Private source note",
      });
      expect(saved.isError).toBeFalsy();
      const product = saved.structuredContent?.product as {
        id: string;
        food_id: string;
        revision_id: string;
      };
      const candidates = await callTool(client, "list_saved", {
        profile_id: p.profileB,
        record_type: "foods",
        scope: "connection",
        q: "олія",
      });
      expect(candidates.isError).toBeFalsy();
      expect(candidates.structuredContent).toMatchObject({
        items: [],
        fallback: { items: [{ id: product.id, source_profile_id: p.profileA }] },
      });
      expect(JSON.stringify(candidates)).not.toContain("Private source note");
      const args = {
        profile_id: p.profileB,
        request_id: randomUUID(),
        source_profile_id: p.profileA,
        record_type: "products",
        record_id: product.id,
        name: "Synthetic oil",
      };
      const linked = await callTool(client, "link_food", args);
      expect(linked.isError).toBeFalsy();
      expect(await callTool(client, "link_food", args)).toEqual(linked);
      const food = linked.structuredContent?.food as {
        id: string;
        food_id: string;
        revision_id: string;
      };
      expect(food).toMatchObject({
        food_id: product.food_id,
        revision_id: product.revision_id,
        note: null,
      });
      expect(food.id).not.toBe(product.id);
      const fresh = await connectedClient(p.bob);
      try {
        const read = await callTool(fresh, "read_food", {
          record_type: "products",
          record_id: food.id,
        });
        expect(read.structuredContent?.product).toMatchObject({
          id: food.id,
          revision_id: product.revision_id,
          name: "Synthetic oil",
          note: null,
        });
      } finally {
        await fresh.close();
      }
      const website = await call(t, "GET", `/api/v1/profiles/${p.profileB}/products/${food.id}`, {
        token: p.bob,
      });
      expect(website.status).toBe(200);
      expect(website.body).toMatchObject({
        product: { id: food.id, food_id: product.food_id, note: null },
      });
    } finally {
      await client.close();
    }
  });

  it("keeps a profile that has not joined out of reach", async () => {
    const bob = new Client({ name: "test", version: "1" });
    const bobToken = (await connect(t, t.firebase.token(`bob-${randomUUID()}`, "Synthetic Bob")))
      .token;
    await bob.connect(
      new StreamableHTTPClientTransport(new URL(`${issuer}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${bobToken}` } },
      }),
    );
    try {
      const aliceProfiles = await callTool(alice, "list_profiles");
      const aliceProfile = (aliceProfiles.structuredContent?.items as { profile_id: string }[])[0]
        ?.profile_id;
      const read = await callTool(bob, "read_diary", {
        profile_id: aliceProfile,
        from: "2026-08-01",
        to: "2026-08-01",
      });
      expect(read.isError).toBe(true);
      expect(read.structuredContent).toMatchObject({ code: "profile_not_available" });
      const bobs = await callTool(bob, "list_profiles");
      expect(bobs.structuredContent?.items).toHaveLength(1);
    } finally {
      await bob.close();
    }
  });
});
