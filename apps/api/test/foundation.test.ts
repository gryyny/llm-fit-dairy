import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "../src/config.js";
import { createDb, runMigrations } from "../src/db/client.js";
import { startApp, type TestApp } from "./app.js";

describe("foundation (AR-1, health)", () => {
  let t: TestApp;

  beforeAll(async () => {
    const webDist = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(webDist, "index.html"), "<!doctype html><title>Food diary</title>");
    await writeFile(
      join(webDist, "privacy.html"),
      "<!doctype html><title>Privacy policy</title><h1>Privacy policy</h1>",
    );
    t = await startApp({ webDist });
  });
  afterAll(() => t.close());

  it("reports health with the running commit", async () => {
    const res = await fetch(`${t.url}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", commit: "test-commit" });
  });

  it("returns JSON 404 for unknown server routes, never website HTML", async () => {
    for (const path of [
      "/api/nope",
      "/api",
      "/api/v1/unknown/route",
      "/oauth/nope",
      "/.well-known/nope",
      "/mcp/nope",
    ]) {
      const res = await fetch(`${t.url}${path}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expect(await res.json()).toMatchObject({ code: "not_found" });
    }
  });

  it("serves the website for non-API paths", async () => {
    const res = await fetch(`${t.url}/connect?request=synthetic`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Food diary</title>");
    // OA-3: the consent screen and every other page refuse to be framed.
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("serves a public policy's HTML without the app shell or authentication", async () => {
    const res = await fetch(`${t.url}/privacy`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("<h1>Privacy policy</h1>");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("can re-run migrations at start without changes", async () => {
    await expect(runMigrations(createDb(t.pool))).resolves.toBeUndefined();
  });
});

describe("startup configuration", () => {
  const compose = {
    DATABASE_URL: "postgres://diary@postgres/diary",
    FIREBASE_PROJECT_ID: "synthetic",
    PUBLIC_HOSTNAME: "diary.example",
    OAUTH_CHATGPT_CLIENT_SECRET_SHA256: "a".repeat(64),
    OAUTH_CHATGPT_REDIRECT_URIS: "https://chatgpt.com/connector_platform_oauth_redirect",
  };

  it("treats a variable Compose passes as empty as unset", () => {
    // Regression: `${OPENAI_APPS_CHALLENGE:-}` reached the app as "" and stopped it at start.
    expect(
      parseEnv({ ...compose, OPENAI_APPS_CHALLENGE: "" }).OPENAI_APPS_CHALLENGE,
    ).toBeUndefined();
    expect(parseEnv({ ...compose, OPENAI_APPS_CHALLENGE: "token" }).OPENAI_APPS_CHALLENGE).toBe(
      "token",
    );
  });

  it("requires the client secret hash and HTTPS redirect URIs", () => {
    expect(() => parseEnv({ ...compose, OAUTH_CHATGPT_CLIENT_SECRET_SHA256: "" })).toThrow();
    expect(() =>
      parseEnv({ ...compose, OAUTH_CHATGPT_REDIRECT_URIS: "http://chatgpt.com/cb" }),
    ).toThrow();
    expect(parseEnv(compose).OAUTH_CHATGPT_REDIRECT_URIS).toEqual([
      "https://chatgpt.com/connector_platform_oauth_redirect",
    ]);
  });
});
