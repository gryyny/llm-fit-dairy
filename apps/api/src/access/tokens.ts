import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { oauthGrants, oauthTokens } from "../db/schema.js";
import { sha256 } from "../ids.js";

/** Nest injection token for our public origin, the OAuth issuer (`https://<host>`). */
export const ISSUER = Symbol("ISSUER");

/** OA-1: the protected resource ChatGPT asks tokens for. */
export const resourceOf = (issuer: string) => `${issuer}/mcp`;

/** OA-5: a valid, unexpired access token of an unrevoked grant for our resource. */
export async function verifyAccessToken(
  db: Db,
  token: string,
  resource: string,
): Promise<{ userId: string; grantId: string } | null> {
  const [access] = await db
    .select({ userId: oauthGrants.userId, grantId: oauthGrants.id })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .where(
      and(
        eq(oauthTokens.tokenHash, sha256(token)),
        eq(oauthTokens.kind, "access"),
        gt(oauthTokens.expiresAt, sql`now()`),
        isNull(oauthGrants.revokedAt),
        eq(oauthGrants.resource, resource),
      ),
    );
  if (!access) return null;
  // Recorded at most once a minute, so parallel tool calls do not contend on the grant row.
  await db
    .update(oauthGrants)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(oauthGrants.id, access.grantId),
        or(
          isNull(oauthGrants.lastUsedAt),
          lt(oauthGrants.lastUsedAt, sql`now() - interval '1 minute'`),
        ),
      ),
    );
  return access;
}
