import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { accounts, connectionInvites, connectionProfiles } from "../db/schema.js";
import { invalidInput } from "../errors.js";
import { newToken } from "../ids.js";
import type { Tx } from "./writes.js";

/** OP-7: profiles one connection may reach, and join links it may have open at once. */
export const MAX_PROFILES = 10;
const MAX_LIVE_INVITES = 5;
const INVITE_SECONDS = 30 * 60;

export const profileView = (p: typeof accounts.$inferSelect) => ({
  profile_id: p.id,
  name: p.displayName,
  version: p.version,
});

/** The profiles a caller reaches: a connection's linked profiles in joining order, or the website user's own. */
export async function listProfiles(
  db: Db | Tx,
  caller: { userId: string; grantId: string | null },
) {
  if (caller.grantId === null) {
    const own = await db.select().from(accounts).where(eq(accounts.ownerUserId, caller.userId));
    return own.map(profileView);
  }
  const rows = await db
    .select({ account: accounts })
    .from(connectionProfiles)
    .innerJoin(accounts, eq(accounts.id, connectionProfiles.accountId))
    .where(eq(connectionProfiles.grantId, caller.grantId))
    .orderBy(asc(connectionProfiles.createdAt), asc(accounts.id));
  return rows.map((r) => profileView(r.account));
}

export const linkedProfileCount = async (db: Db | Tx, grantId: string) =>
  (
    await db
      .select({ n: count() })
      .from(connectionProfiles)
      .where(eq(connectionProfiles.grantId, grantId))
  )[0]?.n ?? 0;

/** ID-4: a single-use join link; only the joining person's own sign-in and approval uses it. */
export async function createInvite(tx: Tx, grantId: string, issuer: string) {
  if ((await linkedProfileCount(tx, grantId)) >= MAX_PROFILES) {
    throw invalidInput(`A connection can reach at most ${MAX_PROFILES} profiles`);
  }
  const [live] = await tx
    .select({ n: count() })
    .from(connectionInvites)
    .where(
      and(eq(connectionInvites.grantId, grantId), gt(connectionInvites.expiresAt, sql`now()`)),
    );
  if ((live?.n ?? 0) >= MAX_LIVE_INVITES) {
    throw invalidInput("Too many open join links; wait for one to be used or expire");
  }
  const code = newToken("fdj_");
  const expiresAt = new Date(Date.now() + INVITE_SECONDS * 1000);
  await tx.insert(connectionInvites).values({ codeHash: code.hash, grantId, expiresAt });
  return {
    join_url: `${issuer}/join?code=${encodeURIComponent(code.token)}`,
    expires_at: expiresAt,
  };
}
