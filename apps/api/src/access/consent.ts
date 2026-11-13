import { eq } from "drizzle-orm";
import { accounts, users } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { Tx } from "../diary/writes.js";

export const CONSENT_VERSION = "4";

export async function requireBodyConsent(tx: Tx, accountId: string, issuer: string) {
  const [owner] = await tx
    .select({ consent: users.consentVersion })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.ownerUserId))
    .where(eq(accounts.id, accountId));
  if (owner?.consent !== CONSENT_VERSION)
    throw new ApiError(
      403,
      "consent_required",
      "The profile owner must review the current data consent in their own Settings before optional body or goal information is saved.",
      { required_version: CONSENT_VERSION, settings_url: `${issuer}/settings` },
    );
}
