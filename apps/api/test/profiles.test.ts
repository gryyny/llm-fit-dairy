import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, startApp, type TestApp } from "./app.js";
import { connect, diary, estimate, inviteCode, join, ownProfile } from "./diary-helpers.js";

interface ProfileItem {
  profile_id: string;
  name: string;
}
interface Me {
  user: { display_name: string; consent_version: string | null };
  profile: ProfileItem;
}

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());

const person = (label: string, provider?: string) =>
  t.firebase.token(`${label}-${randomUUID()}`, `Synthetic ${label}`, provider);
const me = async (token: string) => (await call<Me>(t, "GET", "/api/manage/me", { token })).body;
const count = async (sql: string, params: unknown[]) =>
  Number((await t.pool.query<{ n: string }>(sql, params)).rows[0]?.n);
const profiles = async (token: string) =>
  (await diary<{ items: ProfileItem[] }>(t, token, "GET", "/profiles")).body.items;
const connections = async (firebaseToken: string) =>
  (
    await call<{ items: { connection_id: string; connected_by_me: boolean }[] }>(
      t,
      "GET",
      "/api/manage/connections",
      { token: firebaseToken },
    )
  ).body.items;

describe("profiles (ID-1..ID-3)", () => {
  it("creates one user with one profile at first sign-in", async () => {
    const alice = person("Alice");
    const first = await me(alice);
    expect(first.profile.name).toBe(first.user.display_name);
    expect((await me(alice)).profile).toEqual(first.profile);
    const uid = alice.replace(/^id:/, "");
    expect(await count("SELECT count(*) AS n FROM users WHERE firebase_uid = $1", [uid])).toBe(1);
    const { token } = await connect(t, alice);
    expect(await profiles(token)).toEqual([first.profile]);
  });

  it("renames in chat with versions, replay and isolation, and preserves the name across sign-in", async () => {
    const alice = person("Alice");
    const bob = person("Bob");
    const own = await ownProfile(t, alice);
    const { token } = await connect(t, alice);
    const requestId = randomUUID();
    const renamed = await diary(
      t,
      token,
      "PATCH",
      `/profiles/${own}?version=1`,
      { name: " Ali " },
      requestId,
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ profile: { profile_id: own, name: "Ali", version: 2 } });
    expect(
      (await diary(t, token, "PATCH", `/profiles/${own}?version=1`, { name: " Ali " }, requestId))
        .body,
    ).toEqual(renamed.body);
    expect(
      (await diary(t, token, "PATCH", `/profiles/${own}?version=1`, { name: "stale" })).status,
    ).toBe(409);
    expect(
      (await diary(t, alice, "PATCH", `/profiles/${own}?version=2`, { name: "website" })).status,
    ).toBe(403);
    expect(
      (await call(t, "PATCH", "/api/manage/profile", { token: alice, body: { name: "website" } }))
        .status,
    ).toBe(404);
    expect(
      (
        await diary(t, (await connect(t, bob)).token, "PATCH", `/profiles/${own}?version=2`, {
          name: "other",
        })
      ).status,
    ).toBe(403);
    t.firebase.token(alice.replace(/^id:/, ""), "Changed Google name");
    expect((await me(alice)).profile).toMatchObject({ name: "Ali", version: 2 });
  });

  it("keeps independent profiles apart across chat and website routes", async () => {
    const alice = person("Alice");
    const bob = person("Bob");
    const aliceToken = (await connect(t, alice)).token;
    const bobToken = (await connect(t, bob)).token;
    const aliceProfile = await ownProfile(t, alice);
    await diary(t, aliceToken, "POST", `/profiles/${aliceProfile}/weights`, {
      date: "2026-06-02",
      value: 70,
      unit: "kg",
    });
    expect((await profiles(bobToken)).map((p) => p.profile_id)).not.toContain(aliceProfile);
    for (const token of [bobToken, bob]) {
      const read = await diary(t, token, "GET", `/profiles/${aliceProfile}/weights`);
      expect(read.status).toBe(403);
      expect(read.body).toMatchObject({ code: "profile_not_available" });
    }
    const write = await diary(t, bobToken, "POST", `/profiles/${aliceProfile}/weights`, {
      date: "2026-06-02",
      value: 1,
      unit: "kg",
    });
    expect(write.status).toBe(403);
    const weights = await diary<{ items: { value: number }[] }>(
      t,
      aliceToken,
      "GET",
      `/profiles/${aliceProfile}/weights`,
    );
    expect(weights.body.items.map((w) => w.value)).toEqual([70]);
  });
});

describe("joining a connection (ID-4)", () => {
  it("adds a profile only with that person's own sign-in and consent", async () => {
    const alice = person("Alice");
    const bob = person("Bob");
    const { token, grantId } = await connect(t, alice);
    const code = await inviteCode(t, token);

    const preview = await call(t, "GET", `/api/manage/join?code=${encodeURIComponent(code)}`, {
      token: bob,
    });
    expect(preview.body).toMatchObject({
      join: { requested_by: "Synthetic Alice", already_joined: false },
      consent_required: true,
    });
    expect(await profiles(token)).toHaveLength(1);
    expect((await call(t, "GET", `/api/manage/join?code=${code}`)).status).toBe(401);
    const withoutConsent = await call(t, "POST", "/api/manage/join", {
      token: bob,
      body: { code, approve: true },
    });
    expect(withoutConsent.status).toBe(400);

    const joined = await call(t, "POST", "/api/manage/join", {
      token: bob,
      body: { code, approve: true, consent: true },
    });
    expect(joined.body).toEqual({ joined: true });
    const names = (await profiles(token)).map((p) => p.name);
    expect(names).toEqual(["Synthetic Alice", "Synthetic Bob"]);
    // Bob sees this connection on his website, but nothing about Alice's profile.
    const bobConnections = await connections(bob);
    expect(bobConnections.map((c) => c.connection_id)).toEqual([grantId]);
    expect(bobConnections[0]?.connected_by_me).toBe(false);
    expect(JSON.stringify(bobConnections)).not.toContain("Alice");
  });

  it("uses each link once and refuses expired, declined or unknown links", async () => {
    const alice = person("Alice");
    const { token } = await connect(t, alice);
    const code = await inviteCode(t, token);
    expect((await join(t, token, person("Bob"))).body).toEqual({ joined: true });
    const bob = person("Bob");
    await call(t, "POST", "/api/manage/join", {
      token: bob,
      body: { code, approve: true, consent: true },
    });
    const reused = await call(t, "POST", "/api/manage/join", {
      token: person("Carol"),
      body: { code, approve: true, consent: true },
    });
    expect(reused.status).toBe(404);

    const declinedCode = await inviteCode(t, token);
    const carol = person("Carol");
    const declined = await call(t, "POST", "/api/manage/join", {
      token: carol,
      body: { code: declinedCode, approve: false },
    });
    expect(declined.body).toEqual({ joined: false });
    const again = await call(t, "POST", "/api/manage/join", {
      token: carol,
      body: { code: declinedCode, approve: true, consent: true },
    });
    expect(again.status).toBe(404);

    const expiredCode = await inviteCode(t, token);
    await t.pool.query(
      "UPDATE connection_invites SET expires_at = now() - interval '1 second' WHERE grant_id IN (SELECT grant_id FROM connection_invites)",
    );
    const expired = await call(t, "POST", "/api/manage/join", {
      token: person("Dave"),
      body: { code: expiredCode, approve: true, consent: true },
    });
    expect(expired.status).toBe(404);
    const unknown = await call(t, "POST", "/api/manage/join", {
      token: person("Erin"),
      body: { code: `fdj_${"x".repeat(43)}`, approve: true, consent: true },
    });
    expect(unknown.status).toBe(404);
    expect((await profiles(token)).length).toBe(3);
  });

  it("caps profiles and open links per connection", async () => {
    const { token } = await connect(t, person("Alice"));
    for (let i = 0; i < 9; i++) await join(t, token, person(`Joiner${String(i)}`));
    expect(await profiles(token)).toHaveLength(10);
    const over = await diary(t, token, "POST", "/profiles/invites");
    expect(over.status).toBe(400);

    const other = (await connect(t, person("Alice"))).token;
    for (let i = 0; i < 5; i++) {
      expect((await diary(t, other, "POST", "/profiles/invites")).status).toBe(201);
    }
    expect((await diary(t, other, "POST", "/profiles/invites")).status).toBe(400);
  });

  it("lets each person remove their profile from a connection without affecting the others", async () => {
    const alice = person("Alice");
    const bob = person("Bob");
    const { token, grantId } = await connect(t, alice);
    await join(t, token, bob);
    const bobProfile = await ownProfile(t, bob);
    expect(
      (await call(t, "DELETE", `/api/manage/connections/${grantId}`, { token: bob })).status,
    ).toBe(200);
    expect((await diary(t, token, "GET", `/profiles/${bobProfile}/weights`)).status).toBe(403);
    expect(await profiles(token)).toHaveLength(1);
    expect(await connections(bob)).toEqual([]);
    // Once Alice leaves too, the connection reaches nothing and ends.
    await call(t, "DELETE", `/api/manage/connections/${grantId}`, { token: alice });
    expect((await diary(t, token, "GET", "/profiles")).status).toBe(401);
    expect(
      (await call(t, "DELETE", `/api/manage/connections/${grantId}`, { token: person("Eve") }))
        .status,
    ).toBe(404);
  });
});

describe("credentials at each door (OA-5, AC-5)", () => {
  it("lets the website read its own profile with its Firebase token but never write", async () => {
    const alice = person("Alice");
    const own = await ownProfile(t, alice);
    expect(await profiles(alice)).toHaveLength(1);
    expect(
      (await diary(t, alice, "GET", `/profiles/${own}/diary?from=2026-06-03&to=2026-06-03`)).status,
    ).toBe(200);
    for (const [method, path, body] of [
      ["POST", "/profiles/invites", undefined],
      ["POST", `/profiles/${own}/weights`, { date: "2026-06-03", value: 70, unit: "kg" }],
    ] as const) {
      const res = await diary(t, alice, method, path, body);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "forbidden" });
    }
  });

  it("refuses OAuth tokens on the website API and anything else at the chat API", async () => {
    const { token } = await connect(t, person("Alice"));
    expect((await call(t, "GET", "/api/manage/me", { token })).status).toBe(401);
    for (const bad of [undefined, "fda_unknown", `fdk_${randomUUID()}`, "id:nobody"]) {
      const res = await diary(t, bad ?? "", "GET", "/profiles");
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: "invalid_credential" });
    }
  });

  it("rejects expired, revoked and wrong-resource access tokens", async () => {
    const alice = person("Alice");
    const expired = await connect(t, alice, { expiresInSeconds: -1 });
    const foreign = await connect(t, alice, { resource: "https://elsewhere.test/mcp" });
    const live = await connect(t, alice);
    const other = await connect(t, alice);
    for (const c of [expired, foreign]) {
      expect((await diary(t, c.token, "GET", "/profiles")).status).toBe(401);
    }
    expect((await connections(alice)).map((c) => c.connection_id)).toEqual(
      expect.arrayContaining([live.grantId, other.grantId]),
    );
    await call(t, "DELETE", `/api/manage/connections/${live.grantId}`, { token: alice });
    expect((await diary(t, live.token, "GET", "/profiles")).status).toBe(401);
    expect((await diary(t, other.token, "GET", "/profiles")).status).toBe(200);
    expect((await connections(alice)).map((c) => c.connection_id)).not.toContain(live.grantId);
  });

  it("creates a password user's profile without provisioning and keeps other users isolated", async () => {
    const alice = person("Alice", "password");
    const bob = person("Alice", "password");
    const google = person("Alice");
    const response = await call<Me>(t, "GET", "/api/manage/me", { token: alice });
    expect(response.status).toBe(200);
    const first = response.body;
    expect(first.profile.name).toBe("Synthetic Alice");
    expect((await me(alice)).profile).toEqual(first.profile);
    const uid = alice.replace(/^id:/, "");
    expect(await count("SELECT count(*) AS n FROM users WHERE firebase_uid = $1", [uid])).toBe(1);
    expect((await me(bob)).profile.profile_id).not.toBe(first.profile.profile_id);
    expect((await me(google)).profile.profile_id).not.toBe(first.profile.profile_id);
    expect(
      (
        await diary(
          t,
          bob,
          "GET",
          `/profiles/${first.profile.profile_id}/diary?from=2026-10-19&to=2026-10-19`,
        )
      ).status,
    ).toBe(403);
    const { token } = await connect(t, alice);
    expect(await profiles(token)).toEqual([first.profile]);
    expect(
      (await diary(t, alice, "POST", `/profiles/${first.profile.profile_id}/meals`, {})).status,
    ).toBe(403);
  });

  it("uses the Firebase UID, rather than provider, to identify a linked account", async () => {
    const uid = `linked-${randomUUID()}`;
    const google = t.firebase.token(uid, "Synthetic Linked", "google.com");
    const first = await me(google);
    const password = t.firebase.token(uid, undefined, "password");
    const response = await call<Me>(t, "GET", "/api/manage/me", { token: password });
    expect(response.status).toBe(200);
    expect(response.body.profile).toEqual(first.profile);
    expect(await count("SELECT count(*) AS n FROM users WHERE firebase_uid = $1", [uid])).toBe(1);
  });

  it("refuses other Firebase sign-in providers", async () => {
    const anonymous = person("Anonymous", "anonymous");
    expect((await call(t, "GET", "/api/manage/me", { token: anonymous })).status).toBe(403);
    expect((await diary(t, anonymous, "GET", "/profiles")).status).toBe(403);
    const uid = anonymous.replace(/^id:/, "");
    expect(await count("SELECT count(*) AS n FROM users WHERE firebase_uid = $1", [uid])).toBe(0);
  });

  it("refuses refresh tokens and codes as bearer tokens", async () => {
    const { refreshToken } = await connect(t, person("Alice"));
    for (const bearer of [refreshToken, "fdc_synthetic-code", "fdj_synthetic-code"]) {
      expect((await diary(t, bearer, "GET", "/profiles")).status).toBe(401);
    }
  });

  it("lists only connections that can still refresh", async () => {
    const alice = person("Alice");
    const live = await connect(t, alice);
    const lapsed = await connect(t, alice, { refreshExpiresInSeconds: -1 });
    const ids = (await connections(alice)).map((c) => c.connection_id);
    expect(ids).toContain(live.grantId);
    expect(ids).not.toContain(lapsed.grantId);
  });

  it("keeps one connection's request IDs apart from another's", async () => {
    const shared = randomUUID();
    for (const label of ["Alice", "Bob"]) {
      const someone = person(label);
      const { token } = await connect(t, someone);
      const res = await diary(
        t,
        token,
        "POST",
        `/profiles/${await ownProfile(t, someone)}/weights`,
        { date: "2026-06-05", value: 70, unit: "kg" },
        shared,
      );
      expect(res.status).toBe(201);
    }
  });

  it("keeps the doors independent: a revoked website session leaves connections working", async () => {
    const uid = `alice-${randomUUID()}`;
    const alice = t.firebase.token(uid, "Synthetic Alice");
    const { token } = await connect(t, alice);
    t.firebase.revoke(uid);
    expect((await call(t, "GET", "/api/manage/me", { token: alice })).status).toBe(401);
    expect((await diary(t, token, "GET", "/profiles")).status).toBe(200);
  });

  it("has removed v1 credentials and owned-diary routes", async () => {
    const alice = person("Alice");
    for (const [method, path] of [
      ["POST", "/api/manage/connections"],
      ["GET", "/api/manage/me/grants"],
      ["GET", "/api/v1/accounts"],
      ["GET", "/api/v1/diaries"],
    ]) {
      expect((await call(t, method ?? "GET", path ?? "/", { token: alice })).status).toBe(404);
    }
  });
});

describe("deleting a user (ID-5)", () => {
  it("removes the profile, its records and links, ends connections it authorized or emptied", async () => {
    const uid = `alice-${randomUUID()}`;
    const alice = t.firebase.token(uid, "Synthetic Alice");
    const bob = person("Bob");
    const carol = person("Carol");
    const aliceConnection = await connect(t, alice);
    await join(t, aliceConnection.token, bob);
    const bobConnection = await connect(t, bob);
    await join(t, bobConnection.token, alice);
    const carolConnection = await connect(t, carol);
    await join(t, carolConnection.token, alice);
    await call(t, "DELETE", `/api/manage/connections/${carolConnection.grantId}`, { token: carol });
    const aliceProfile = await ownProfile(t, alice);
    await diary(t, aliceConnection.token, "POST", `/profiles/${aliceProfile}/meals`, {
      diary_date: "2026-06-04",
      entries: [estimate("Soup", 150)],
    });

    expect((await call(t, "DELETE", "/api/manage/me", { token: alice })).status).toBe(200);
    expect(t.firebase.deleted).toContain(uid);
    expect(
      await count("SELECT count(*) AS n FROM meals WHERE account_id = $1", [aliceProfile]),
    ).toBe(0);
    // The connection Alice authorized ends; Bob's keeps Bob; Carol's, left empty, ends.
    expect((await diary(t, aliceConnection.token, "GET", "/profiles")).status).toBe(401);
    expect((await profiles(bobConnection.token)).map((p) => p.name)).toEqual(["Synthetic Bob"]);
    expect((await diary(t, carolConnection.token, "GET", "/profiles")).status).toBe(401);
  });
});
