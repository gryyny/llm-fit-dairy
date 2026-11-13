import { createHash } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Pool } from "pg";
import type { FirebaseVerifier, VerifiedUser } from "../src/access/firebase.js";
import { createApp, type AppOptions } from "../src/app.js";
import { createPool } from "./db.js";

/**
 * Stub for Firebase (OP-5): `id:<uid>` tokens verify as that user until the user's sessions are
 * revoked or the user is deleted, mirroring `verifyIdToken(token, true)`.
 */
class FakeFirebase implements FirebaseVerifier {
  private readonly revoked = new Set<string>();
  private readonly users = new Map<string, { name: string | null; provider: string }>();
  readonly deleted: string[] = [];

  token(uid: string, name?: string, provider = "google.com"): string {
    this.users.set(uid, { name: name ?? null, provider });
    return `id:${uid}`;
  }

  revoke(uid: string): void {
    this.revoked.add(uid);
  }

  verify(idToken: string): Promise<VerifiedUser | null> {
    const uid = /^id:(.+)$/.exec(idToken)?.[1];
    const user = uid ? this.users.get(uid) : undefined;
    if (!uid || !user || this.revoked.has(uid)) return Promise.resolve(null);
    return Promise.resolve({ uid, ...user });
  }

  deleteUser(uid: string): Promise<void> {
    this.deleted.push(uid);
    this.users.delete(uid);
    return Promise.resolve();
  }
}

export const ISSUER = "https://diary.test";

/** The provided ChatGPT client as configured for tests (OA-2). */
export const CLIENT = {
  id: "chatgpt",
  secret: "synthetic-client-secret",
  redirectUri: "https://chatgpt.test/connector/oauth/callback",
};

export interface TestApp {
  url: string;
  issuer: string;
  pool: Pool;
  app: NestExpressApplication;
  firebase: FakeFirebase;
  close: () => Promise<void>;
}

export async function startApp(options: Partial<AppOptions> = {}, port = 0): Promise<TestApp> {
  const pool = createPool();
  const firebase = new FakeFirebase();
  const app = await createApp({
    pool,
    commit: "test-commit",
    logger: false,
    firebase,
    issuer: ISSUER,
    oauth: {
      clients: [
        {
          id: CLIENT.id,
          secretSha256: createHash("sha256").update(CLIENT.secret).digest("hex"),
          redirectUris: [CLIENT.redirectUri],
        },
      ],
      appsChallenge: "synthetic-challenge-token",
    },
    // Suites make many calls per user; OP-7's limit has its own test with a low value.
    rateLimitPerMinute: 100_000,
    ...options,
  });
  await app.listen(port, "127.0.0.1");
  const url = await app.getUrl();
  return {
    url: url.replace("[::1]", "127.0.0.1"),
    issuer: options.issuer ?? ISSUER,
    pool,
    app,
    firebase,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export interface Response<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

/** JSON request with an optional bearer token; the body is typed by the caller. */
export async function call<T = Record<string, unknown>>(
  t: TestApp,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response<T>> {
  const res = await fetch(`${t.url}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
}
