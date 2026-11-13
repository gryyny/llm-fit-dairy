import { createHash, randomBytes } from "node:crypto";
import { call, CLIENT, type TestApp } from "./app.js";

export const pkce = () => {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

export const basic = (id = CLIENT.id, secret = CLIENT.secret) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;

/** GET /oauth/authorize without following the redirect. */
export function authorize(t: TestApp, params: Record<string, string | undefined>) {
  const url = new URL(`${t.url}/oauth/authorize`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return fetch(url, { redirect: "manual" });
}

export const authorizeParams = (challenge: string, extra: Record<string, string> = {}) => ({
  response_type: "code",
  client_id: CLIENT.id,
  redirect_uri: CLIENT.redirectUri,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "synthetic-state",
  ...extra,
});

/**
 * The browser's connect cookie from `/oauth/authorize` (OA-3), as a `Cookie` header value; the
 * redirect itself carries no request ID.
 */
export function connectCookie(started: globalThis.Response): string {
  if (started.headers.get("location") !== "/connect") throw new Error("not sent to /connect");
  const cookie = /fd_connect=[0-9a-f-]{36}/.exec(started.headers.get("set-cookie") ?? "")?.[0];
  if (!cookie) throw new Error("no connect cookie");
  return cookie;
}

/** The website approving or denying a request with the person's Firebase token. */
export async function decide(
  t: TestApp,
  firebaseToken: string,
  cookie: string,
  approve = true,
  /** `null` leaves consent out of the request. */
  consent: boolean | null = true,
) {
  return call<{ redirect_to: string }>(t, "POST", "/api/manage/oauth/decision", {
    token: firebaseToken,
    headers: { Cookie: cookie },
    body: { approve, ...(consent === null ? {} : { consent }) },
  });
}

/** POST /oauth/token with form encoding, as ChatGPT sends it. */
export async function tokenRequest(
  t: TestApp,
  params: Record<string, string>,
  authorization: string | null = basic(),
) {
  const res = await fetch(`${t.url}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: new URLSearchParams(params),
  });
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json()) as Record<string, unknown>,
  };
}

/** The whole authorization-code flow for one person; returns the token response. */
export async function connectThroughOAuth(t: TestApp, firebaseToken: string) {
  const { verifier, challenge } = pkce();
  const started = await authorize(t, authorizeParams(challenge));
  const decided = await decide(t, firebaseToken, connectCookie(started));
  const code = new URL(decided.body.redirect_to).searchParams.get("code") ?? "";
  return tokenRequest(t, {
    grant_type: "authorization_code",
    code,
    redirect_uri: CLIENT.redirectUri,
    code_verifier: verifier,
  });
}
