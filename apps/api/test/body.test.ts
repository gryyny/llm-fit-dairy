import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, startApp, type TestApp } from "./app.js";
import { diary, setupProfiles, type Setup } from "./diary-helpers.js";

let t: TestApp;
let s: Setup;
beforeAll(async () => {
  t = await startApp();
  s = await setupProfiles(t);
});
afterAll(() => t.close());
const root = () => `/profiles/${s.profileA}`;
interface Context {
  version: number;
  height: { value: number; unit: string } | null;
  date_of_birth: string | null;
  age: { years: number; as_of: string } | null;
  activity: string | null;
  goal: string | null;
}
interface Read {
  profile: { profile_id: string; name: string; version: number };
  body_context: Context | null;
}
const consent = (token: string, body: unknown = { version: "4", consent: true }) =>
  call(t, "POST", "/api/manage/consent", { token, body });

describe("optional body context and agreed goal inputs", () => {
  it("reads absent context without creating it and requires selected-owner consent", async () => {
    expect((await diary<Read>(t, s.token, "GET", root())).body.body_context).toBeNull();
    expect(
      (
        await t.pool.query("SELECT count(*)::int AS n FROM body_contexts WHERE account_id=$1", [
          s.profileA,
        ])
      ).rows[0],
    ).toEqual({ n: 0 });
    const refused = await diary(t, s.token, "PATCH", `${root()}/body-context?version=0`, {
      height: { value: 180, unit: "cm" },
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      code: "consent_required",
      current: { required_version: "4", settings_url: `${t.issuer}/settings` },
    });
    expect((await consent(s.alice, { version: "3", consent: true })).status).toBe(400);
    expect((await consent(s.alice, { version: "4", consent: false })).status).toBe(400);
    expect((await consent(s.token)).status).toBe(401);
    expect((await consent(s.alice)).status).toBe(200);
    // Bob's consent cannot be replaced by the owner of the connection that reaches him.
    await t.pool.query(
      "UPDATE users SET consent_version='2' WHERE id=(SELECT owner_user_id FROM accounts WHERE id=$1)",
      [s.profileB],
    );
    expect(
      (
        await diary(t, s.token, "PATCH", `/profiles/${s.profileB}/body-context?version=0`, {
          goal: "Synthetic goal",
        })
      ).status,
    ).toBe(403);
    expect((await consent(s.bob)).status).toBe(200);
  });

  it("serializes initial creation, replays patches and preserves omitted versus cleared fields", async () => {
    const requestId = randomUUID();
    const patch = {
      height: { value: 180, unit: "cm" },
      age: { years: 30, as_of: "2026-10-20" },
      activity: "Synthetic moderate",
      goal: "Synthetic maintenance",
    };
    const paths = `${root()}/body-context?version=0`;
    const results = await Promise.all([
      diary<{ body_context: Context }>(t, s.token, "PATCH", paths, patch, requestId),
      diary<{ body_context: Context }>(t, s.token, "PATCH", paths, {
        height: { value: 181, unit: "cm" },
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    // The winning create may be either command; replay its exact request.
    const won = results[0].status === 200;
    if (won)
      expect((await diary(t, s.token, "PATCH", paths, patch, requestId)).body).toEqual(
        results[0].body,
      );
    const read = (await diary<Read>(t, s.token, "GET", root())).body.body_context;
    if (!read) throw new Error("context missing");
    const updated = await diary<{ body_context: Context }>(
      t,
      s.token,
      "PATCH",
      `${root()}/body-context?version=1`,
      { height: null, activity: "Synthetic walking" },
    );
    expect(updated.body.body_context).toEqual({
      ...read,
      height: null,
      activity: "Synthetic walking",
      version: 2,
    });
    expect(
      (await diary(t, s.token, "PATCH", `${root()}/body-context?version=1`, { goal: "stale" }))
        .status,
    ).toBe(409);
    for (const invalid of [
      { height: { value: 180 } },
      { age: { years: 17, as_of: "2026-10-20" } },
      { birthday: "1990-01-01" },
      {},
    ])
      expect(
        (await diary(t, s.token, "PATCH", `${root()}/body-context?version=2`, invalid)).status,
      ).toBe(400);
    expect(
      (
        await diary(t, s.alice, "PATCH", `${root()}/body-context?version=2`, {
          goal: "website write",
        })
      ).status,
    ).toBe(403);
    expect((await diary(t, s.carolToken, "GET", root())).status).toBe(403);
  });

  it("keeps target rationale and supplied input snapshots stable and clears omitted explanations on replacement", async () => {
    const context = (await diary<Read>(t, s.token, "GET", root())).body.body_context;
    if (!context) throw new Error("context missing");
    const { version, ...fields } = context;
    const weight = await diary<{
      weight: { id: string; version: number; date: string; value: number; unit: string };
    }>(t, s.token, "POST", `${root()}/weights`, { date: "2026-10-20", value: 80, unit: "kg" });
    const w = weight.body.weight;
    const inputs = {
      body_context: { version, fields },
      weight: { id: w.id, version: w.version, date: w.date, value: w.value, unit: w.unit },
    };
    const body = {
      kind: "normal",
      effective_from: "2026-10-20",
      values: { energy_kcal: { value: 2000 } },
      rationale: "Synthetic user-agreed target",
      inputs,
    };
    const saved = await diary<{ target: { id: string; inputs: unknown } }>(
      t,
      s.token,
      "POST",
      `${root()}/targets`,
      body,
    );
    expect(saved.status).toBe(201);
    await diary(t, s.token, "PATCH", `${root()}/body-context?version=2`, {
      activity: "Synthetic changed",
    });
    await diary(t, s.token, "PUT", `${root()}/weights/${w.id}?version=1`, {
      date: w.date,
      value: 81,
      unit: "kg",
    });
    const history = await diary<{ items: { id: string; inputs: unknown }[] }>(
      t,
      s.token,
      "GET",
      `${root()}/targets`,
    );
    expect(history.body.items.find((v) => v.id === saved.body.target.id)?.inputs).toEqual(inputs);
    const foreign = await diary<{ weight: { id: string } }>(
      t,
      s.token,
      "POST",
      `/profiles/${s.profileB}/weights`,
      { date: w.date, value: 75, unit: "kg" },
    );
    expect(
      (
        await diary(t, s.token, "POST", `${root()}/targets`, {
          ...body,
          effective_from: "2026-10-21",
          inputs: { weight: { ...inputs.weight, id: foreign.body.weight.id } },
        })
      ).status,
    ).toBe(400);
    const replaced = await diary(
      t,
      s.token,
      "PUT",
      `${root()}/targets/${saved.body.target.id}?version=1`,
      {
        kind: body.kind,
        effective_from: body.effective_from,
        values: { energy_kcal: { value: 2100 } },
      },
    );
    expect(replaced.body).toMatchObject({ target: { rationale: null, inputs: null, version: 2 } });
  });

  it("permits clearing optional fields and plain logging without renewed consent", async () => {
    await t.pool.query(
      "UPDATE users SET consent_version='2' WHERE id=(SELECT owner_user_id FROM accounts WHERE id=$1)",
      [s.profileA],
    );
    const current = (await diary<Read>(t, s.token, "GET", root())).body.body_context;
    const cleared = await diary(
      t,
      s.token,
      "PATCH",
      `${root()}/body-context?version=${current?.version}`,
      { height: null, date_of_birth: null, age: null, activity: null, goal: null },
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({
      body_context: {
        height: null,
        age: null,
        activity: null,
        goal: null,
        version: (current?.version ?? 0) + 1,
      },
    });
    expect(
      (
        await diary(t, s.token, "POST", `${root()}/targets`, {
          kind: "training",
          effective_from: "2026-10-20",
          values: { energy_kcal: { value: 2200 } },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await diary(t, s.token, "POST", `${root()}/targets`, {
          kind: "normal",
          effective_from: "2026-10-22",
          values: { energy_kcal: { value: 2200 } },
          rationale: "Optional health explanation",
        })
      ).status,
    ).toBe(403);
    const me = await call(t, "GET", "/api/manage/me", { token: s.alice });
    expect(me.body).toMatchObject({ consent_required: true, consent_version: "4" });
    await consent(s.alice);
    expect((await call(t, "GET", "/api/manage/me", { token: s.alice })).body).toMatchObject({
      consent_required: false,
    });
    expect((await call(t, "DELETE", "/api/manage/me", { token: s.alice })).status).toBe(200);
    expect(
      (
        await t.pool.query("SELECT count(*)::int AS n FROM body_contexts WHERE account_id=$1", [
          s.profileA,
        ])
      ).rows[0],
    ).toEqual({ n: 0 });
    expect(
      (
        await t.pool.query("SELECT count(*)::int AS n FROM request_results WHERE account_id=$1", [
          s.profileA,
        ])
      ).rows[0],
    ).toEqual({ n: 0 });
  });
});
