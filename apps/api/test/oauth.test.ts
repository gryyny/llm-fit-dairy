import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, CLIENT, ISSUER, startApp, type TestApp } from "./app.js";
import { diary } from "./diary-helpers.js";
import {
  authorize,
  authorizeParams,
  basic,
  connectCookie,
  connectThroughOAuth,
  decide,
  pkce,
  tokenRequest,
} from "./oauth-flow.js";

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());

const person = () => t.firebase.token(`user-${randomUUID()}`, "Synthetic person");

describe("discovery (OA-1)", () => {
  it("publishes resource and authorization-server metadata that match", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await call(t, "GET", path);
      expect(res.body).toMatchObject({
        resource: `${ISSUER}/mcp`,
        authorization_servers: [ISSUER],
        scopes_supported: ["diary"],
      });
    }
    const as = await call(t, "GET", "/.well-known/oauth-authorization-server");
    expect(as.body).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
    expect(as.body).not.toHaveProperty("registration_endpoint");
  });

  it("serves the domain-verification token as plain text", async () => {
    const res = await fetch(`${t.url}/.well-known/openai-apps-challenge`);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe("synthetic-challenge-token");
  });
});

describe("authorization requests (OA-3)", () => {
  it("never redirects to an unknown client or unregistered redirect URI", async () => {
    const { challenge } = pkce();
    const cases: Record<string, string>[] = [
      { client_id: "someone-else" },
      { redirect_uri: "https://attacker.test/callback" },
      { redirect_uri: `${CLIENT.redirectUri}/extra` },
    ];
    for (const extra of cases) {
      const res = await authorize(t, authorizeParams(challenge, extra));
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("redirects other errors back with state and iss", async () => {
    const { challenge } = pkce();
    const cases: [Record<string, string | undefined>, string][] = [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge: undefined }, "invalid_request"],
      [{ resource: "https://elsewhere.test/mcp" }, "invalid_target"],
    ];
    for (const [extra, error] of cases) {
      const res = await authorize(t, { ...authorizeParams(challenge), ...extra });
      expect(res.status).toBe(302);
      const back = new URL(res.headers.get("location") ?? "");
      expect(`${back.origin}${back.pathname}`).toBe(CLIENT.redirectUri);
      expect(Object.fromEntries(back.searchParams)).toMatchObject({
        error,
        state: "synthetic-state",
        iss: ISSUER,
      });
    }
  });

  it("asks for consent once, then issues a code with state and iss", async () => {
    const alice = person();
    const { challenge } = pkce();
    const started = await authorize(t, authorizeParams(challenge, { resource: `${ISSUER}/mcp` }));
    expect(started.status).toBe(302);
    const setCookie = started.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\/api\/manage\/oauth/);
    const cookie = connectCookie(started);

    const info = (token?: string) =>
      call(t, "GET", "/api/manage/oauth/request", { token, headers: { Cookie: cookie } });
    expect((await info(alice)).body).toMatchObject({
      consent_required: true,
      request: { client: "chatgpt" },
    });
    expect((await info()).status).toBe(401);

    const withoutConsent = await decide(t, alice, cookie, true, null);
    expect(withoutConsent.status).toBe(400);
    const approved = await decide(t, alice, cookie);
    const back = new URL(approved.body.redirect_to);
    expect(back.searchParams.get("code")).toMatch(/^fdc_/);
    expect(back.searchParams.get("state")).toBe("synthetic-state");
    expect(back.searchParams.get("iss")).toBe(ISSUER);
    expect((await decide(t, alice, cookie)).status).toBe(404);

    const again = connectCookie(await authorize(t, authorizeParams(pkce().challenge)));
    const second = await call(t, "GET", "/api/manage/oauth/request", {
      token: alice,
      headers: { Cookie: again },
    });
    expect(second.body).toMatchObject({ consent_required: false });
  });

  it("approves only from the browser that started connecting", async () => {
    connectCookie(await authorize(t, authorizeParams(pkce().challenge)));
    const elsewhere = await call(t, "POST", "/api/manage/oauth/decision", {
      token: person(),
      body: { approve: true, consent: true },
    });
    expect(elsewhere.status).toBe(404);
  });

  it("asks again when a person reconnects after consenting to an older notice", async () => {
    const alice = person();
    await connectThroughOAuth(t, alice);
    await t.pool.query("UPDATE users SET consent_version = '1' WHERE firebase_uid = $1", [
      alice.replace(/^id:/, ""),
    ]);
    const cookie = connectCookie(await authorize(t, authorizeParams(pkce().challenge)));
    const request = await call(t, "GET", "/api/manage/oauth/request", {
      token: alice,
      headers: { Cookie: cookie },
    });
    expect(request.body).toMatchObject({ consent_required: true, consent_version: "4" });
    expect((await decide(t, alice, cookie, true, null)).status).toBe(400);
    expect((await decide(t, alice, cookie)).status).toBe(200);
    const me = await call(t, "GET", "/api/manage/me", { token: alice });
    expect(me.body).toMatchObject({ user: { consent_version: "4" } });
  });

  it("returns access_denied when the person cancels", async () => {
    const started = await authorize(t, authorizeParams(pkce().challenge));
    const denied = await decide(t, person(), connectCookie(started), false);
    expect(Object.fromEntries(new URL(denied.body.redirect_to).searchParams)).toMatchObject({
      error: "access_denied",
      state: "synthetic-state",
      iss: ISSUER,
    });
  });

  it("refuses an expired request", async () => {
    const cookie = connectCookie(await authorize(t, authorizeParams(pkce().challenge)));
    const requestId = cookie.split("=")[1];
    await t.pool.query(
      "UPDATE oauth_requests SET expires_at = now() - interval '1 second' WHERE id = $1",
      [requestId],
    );
    expect((await decide(t, person(), cookie)).status).toBe(404);
  });
});

describe("token endpoint (OA-4)", () => {
  async function codeFor(firebaseToken: string) {
    const { verifier, challenge } = pkce();
    const started = await authorize(t, authorizeParams(challenge));
    const decided = await decide(t, firebaseToken, connectCookie(started));
    return { code: new URL(decided.body.redirect_to).searchParams.get("code") ?? "", verifier };
  }
  const exchange = (code: string, verifier: string, extra: Record<string, string> = {}) => ({
    grant_type: "authorization_code",
    code,
    redirect_uri: CLIENT.redirectUri,
    code_verifier: verifier,
    ...extra,
  });

  it("exchanges a code once for tokens that reach the person's diaries", async () => {
    const alice = person();
    const { code, verifier } = await codeFor(alice);
    const issued = await tokenRequest(t, exchange(code, verifier, { resource: `${ISSUER}/mcp` }));
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    expect(issued.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "diary" });
    const access = String(issued.body.access_token);
    expect(access).toMatch(/^fda_/);
    expect(String(issued.body.refresh_token)).toMatch(/^fdr_/);
    expect((await diary(t, access, "GET", "/profiles")).status).toBe(200);

    const reused = await tokenRequest(t, exchange(code, verifier));
    expect(reused.body).toMatchObject({ error: "invalid_grant" });
    // Only hashes are stored, never the token itself.
    const stored = await t.pool.query(
      "SELECT count(*)::int AS n FROM oauth_tokens WHERE token_hash = $1",
      [access],
    );
    expect(stored.rows[0]).toEqual({ n: 0 });
  });

  it("rejects a wrong verifier, redirect URI, resource, expiry or client", async () => {
    const alice = person();
    const wrong = [
      (c: { code: string; verifier: string }) => exchange(c.code, pkce().verifier),
      (c: { code: string; verifier: string }) =>
        exchange(c.code, c.verifier, { redirect_uri: "https://chatgpt.test/other" }),
    ];
    for (const build of wrong) {
      const res = await tokenRequest(t, build(await codeFor(alice)));
      expect(res.body).toMatchObject({ error: "invalid_grant" });
    }
    const wrongResource = await codeFor(alice);
    expect(
      (
        await tokenRequest(
          t,
          exchange(wrongResource.code, wrongResource.verifier, {
            resource: "https://elsewhere.test/mcp",
          }),
        )
      ).body,
    ).toMatchObject({ error: "invalid_target" });

    const expired = await codeFor(alice);
    await t.pool.query("UPDATE oauth_codes SET expires_at = now() - interval '1 second'");
    expect((await tokenRequest(t, exchange(expired.code, expired.verifier))).body).toMatchObject({
      error: "invalid_grant",
    });

    const fresh = await codeFor(alice);
    const badClient = await tokenRequest(
      t,
      exchange(fresh.code, fresh.verifier),
      basic(CLIENT.id, "not-the-secret"),
    );
    expect(badClient.status).toBe(401);
    expect(badClient.headers.get("www-authenticate")).toMatch(/^Basic/);
    expect(badClient.body).toMatchObject({ error: "invalid_client" });
    const viaPost = await tokenRequest(
      t,
      exchange(fresh.code, fresh.verifier, { client_id: CLIENT.id, client_secret: CLIENT.secret }),
      null,
    );
    expect(viaPost.status).toBe(200);
  });

  it("exchanges a code exactly once under concurrent requests", async () => {
    const { code, verifier } = await codeFor(person());
    const results = await Promise.all(
      Array.from({ length: 5 }, () => tokenRequest(t, exchange(code, verifier))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400, 400, 400]);
  });

  it("accepts form-encoded client credentials in HTTP Basic", async () => {
    const secret = "a b+c%d:e";
    const odd = await startApp({
      oauth: {
        clients: [
          {
            id: CLIENT.id,
            secretSha256: createHash("sha256").update(secret).digest("hex"),
            redirectUris: [CLIENT.redirectUri],
          },
        ],
      },
    });
    try {
      const encoded = `Basic ${Buffer.from(`${CLIENT.id}:a+b%2Bc%25d%3Ae`).toString("base64")}`;
      const res = await tokenRequest(
        odd,
        { grant_type: "refresh_token", refresh_token: "x" },
        encoded,
      );
      expect(res.body).toMatchObject({ error: "invalid_grant" });
      const wrong = await tokenRequest(odd, { grant_type: "refresh_token", refresh_token: "x" });
      expect(wrong.body).toMatchObject({ error: "invalid_client" });
    } finally {
      await odd.close();
    }
  });

  it("rotates refresh tokens and revokes the connection when an old one is replayed", async () => {
    const alice = person();
    const first = (await connectThroughOAuth(t, alice)).body;
    const refresh = (token: unknown) =>
      tokenRequest(t, { grant_type: "refresh_token", refresh_token: String(token) });
    const second = await refresh(first.refresh_token);
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);

    // A retry after a lost response gets a fresh pair instead of a forced reconnect.
    const retried = await refresh(first.refresh_token);
    expect(retried.status).toBe(200);
    expect(retried.body.refresh_token).not.toBe(second.body.refresh_token);
    expect((await diary(t, String(second.body.access_token), "GET", "/profiles")).status).toBe(200);

    await t.pool.query(
      "UPDATE oauth_tokens SET used_at = now() - interval '2 minutes' WHERE used_at IS NOT NULL",
    );
    expect((await refresh(first.refresh_token)).body).toMatchObject({ error: "invalid_grant" });
    expect((await diary(t, String(second.body.access_token), "GET", "/profiles")).status).toBe(401);
    expect((await refresh(second.body.refresh_token)).body).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("stops refresh after revocation by the client or on the website", async () => {
    const alice = person();
    const viaClient = (await connectThroughOAuth(t, alice)).body;
    const revoke = await fetch(`${t.url}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic() },
      body: new URLSearchParams({ token: String(viaClient.refresh_token) }),
    });
    expect(revoke.status).toBe(200);
    expect((await diary(t, String(viaClient.access_token), "GET", "/profiles")).status).toBe(401);

    const viaWebsite = (await connectThroughOAuth(t, alice)).body;
    const connections = await call<{ items: { connection_id: string }[] }>(
      t,
      "GET",
      "/api/manage/connections",
      { token: alice },
    );
    const [connection] = connections.body.items;
    await call(t, "DELETE", `/api/manage/connections/${connection?.connection_id ?? ""}`, {
      token: alice,
    });
    const refused = await tokenRequest(t, {
      grant_type: "refresh_token",
      refresh_token: String(viaWebsite.refresh_token),
    });
    expect(refused.body).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses unsupported grant types", async () => {
    expect((await tokenRequest(t, { grant_type: "client_credentials" })).body).toMatchObject({
      error: "unsupported_grant_type",
    });
  });
});

describe("resource server (OA-5, OP-7)", () => {
  it("challenges unauthenticated MCP requests with the resource metadata", async () => {
    const post = (authorization?: string) =>
      fetch(`${t.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    const anonymous = await post();
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp", scope="diary"`,
    );
    const invalid = await post("Bearer fda_not-a-token");
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("refuses MCP requests from a foreign browser origin", async () => {
    const token = String((await connectThroughOAuth(t, person())).body.access_token);
    const res = await fetch(`${t.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        Origin: "https://attacker.test",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(403);
  });

  it("limits requests per user", async () => {
    const limited = await startApp({ rateLimitPerMinute: 3 });
    try {
      const someone = limited.firebase.token(`user-${randomUUID()}`, "Synthetic person");
      const token = String((await connectThroughOAuth(limited, someone)).body.access_token);
      const statuses = [];
      for (let i = 0; i < 4; i++)
        statuses.push((await diary(limited, token, "GET", "/profiles")).status);
      expect(statuses).toEqual([200, 200, 200, 429]);
    } finally {
      await limited.close();
    }
  });
});
