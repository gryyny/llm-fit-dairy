import { randomUUID } from "node:crypto";
import { newToken, uuidv7 } from "../src/ids.js";
import { call, type Response, type TestApp } from "./app.js";

export interface Connection {
  /** OAuth access token, as ChatGPT would hold it after connecting. */
  token: string;
  grantId: string;
  refreshToken: string;
}

/**
 * Stands in for a completed OAuth connection: one grant linked to the profile of the person behind
 * `firebaseToken`, with a one-hour access token and a refresh token. The authorization flow itself
 * is tested separately.
 */
export async function connect(
  t: TestApp,
  firebaseToken: string,
  options: { resource?: string; expiresInSeconds?: number; refreshExpiresInSeconds?: number } = {},
): Promise<Connection> {
  const profileId = await ownProfile(t, firebaseToken);
  const uid = firebaseToken.replace(/^id:/, "");
  const user = await t.pool.query<{ id: string }>("SELECT id FROM users WHERE firebase_uid = $1", [
    uid,
  ]);
  const grantId = uuidv7();
  await t.pool.query(
    "INSERT INTO oauth_grants (id, user_id, client_id, resource, scope) VALUES ($1, $2, 'chatgpt', $3, 'diary')",
    [grantId, user.rows[0]?.id, options.resource ?? `${t.issuer}/mcp`],
  );
  await t.pool.query("INSERT INTO connection_profiles (grant_id, account_id) VALUES ($1, $2)", [
    grantId,
    profileId,
  ]);
  const { token, hash } = newToken("fda_");
  await t.pool.query(
    "INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES ($1, $2, 'access', now() + make_interval(secs => $3))",
    [hash, grantId, options.expiresInSeconds ?? 3600],
  );
  const refresh = newToken("fdr_");
  await t.pool.query(
    "INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES ($1, $2, 'refresh', now() + make_interval(secs => $3))",
    [refresh.hash, grantId, options.refreshExpiresInSeconds ?? 86_400],
  );
  return { token, grantId, refreshToken: refresh.token };
}

/** The signed-in person's profile ID, creating the profile at first sign-in. */
export async function ownProfile(t: TestApp, firebaseToken: string): Promise<string> {
  const me = await call<{ profile: { profile_id: string } }>(t, "GET", "/api/manage/me", {
    token: firebaseToken,
  });
  return me.body.profile.profile_id;
}

/** A join code from `add_profile`'s route, as the link carries it. */
export async function inviteCode(t: TestApp, token: string): Promise<string> {
  const res = await diary<{ invite: { join_url: string } }>(t, token, "POST", "/profiles/invites");
  return new URL(res.body.invite.join_url).searchParams.get("code") ?? "";
}

/** ID-4: the joining person opens the link, signs in and approves. */
export async function join(t: TestApp, token: string, joinerFirebaseToken: string) {
  return call<{ joined: boolean }>(t, "POST", "/api/manage/join", {
    token: joinerFirebaseToken,
    body: { code: await inviteCode(t, token), approve: true, consent: true },
  });
}

export interface Setup {
  /** Alice's and Bob's independent profiles; both joined Alice's ChatGPT connection. */
  profileA: string;
  profileB: string;
  /** Firebase ID tokens of Alice and Bob. */
  alice: string;
  bob: string;
  /** Alice's ChatGPT connection, reaching A and B. */
  token: string;
  /** Carol's own connection, reaching only Carol's profile. */
  carolToken: string;
  carolProfile: string;
}

/** Synthetic people: Alice connects and Bob joins her connection; Carol connects on her own. */
export async function setupProfiles(t: TestApp): Promise<Setup> {
  const run = randomUUID();
  const alice = t.firebase.token(`alice-${run}`, "Synthetic Alice");
  const bob = t.firebase.token(`bob-${run}`, "Synthetic Bob");
  const carol = t.firebase.token(`carol-${run}`, "Synthetic Carol");
  const { token } = await connect(t, alice);
  await join(t, token, bob);
  return {
    profileA: await ownProfile(t, alice),
    profileB: await ownProfile(t, bob),
    alice,
    bob,
    token,
    carolToken: (await connect(t, carol)).token,
    carolProfile: await ownProfile(t, carol),
  };
}

/** A chat-data request; writes get a fresh request ID unless one is given (DA-9). */
export function diary<T = Record<string, unknown>>(
  t: TestApp,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  requestId?: string,
): Promise<Response<T>> {
  const write = method !== "GET";
  return call<T>(t, method, `/api/v1${path}`, {
    token,
    body,
    headers: write ? { "Idempotency-Key": requestId ?? randomUUID() } : {},
  });
}

export const estimate = (name: string, energy: number, extra: Record<string, unknown> = {}) => ({
  name,
  quantity: 1,
  unit: "serving",
  nutrients: { energy_kcal: energy },
  source: "estimate",
  note: "synthetic estimate",
  ...(extra.product_id || extra.recipe_id || extra.food_ref
    ? {}
    : { diary_only_reason: "one_off_restaurant" }),
  ...extra,
});

/** Seeds migrated unknown metadata without inventing a classification or source. */
export async function legacyProduct(
  t: TestApp,
  accountId: string,
  name: string,
  barcode: string | null = null,
  gtinKey: string | null = null,
) {
  const id = uuidv7();
  const content = {
    kind: "product",
    brand: null,
    barcode,
    gtinKey,
    foodKind: null,
    variant: null,
    preparation: null,
    provenance: null,
    basisAmount: 100,
    basisUnit: "g",
    nutrients: {},
  };
  await t.pool.query("INSERT INTO food_definitions (id) VALUES ($1)", [id]);
  await t.pool.query(
    "INSERT INTO food_revisions (id,food_id,content,fingerprint) VALUES ($1,$1,$2,encode(sha256(convert_to(($2::jsonb - 'barcode' - 'gtinKey')::text,'UTF8')),'hex'))",
    [id, JSON.stringify(content)],
  );
  await t.pool.query(
    "INSERT INTO products (id,account_id,food_id,revision_id,name) VALUES ($1,$2,$1,$1,$3)",
    [id, accountId, name],
  );
  return id;
}
