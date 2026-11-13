import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "../db/client.js";
import { bodyContexts, weights } from "../db/schema.js";
import { requireBodyConsent } from "../access/consent.js";
import { invalidInput } from "../errors.js";
import type { target } from "./schemas.js";
import type { Tx } from "./writes.js";

export async function readBody(db: Db | Tx, accountId: string) {
  const [row] = await db.select().from(bodyContexts).where(eq(bodyContexts.accountId, accountId));
  return row
    ? {
        version: row.version,
        height: row.height,
        date_of_birth: row.dateOfBirth,
        age: row.age,
        activity: row.activity,
        goal: row.goal,
      }
    : null;
}

export async function validateGoalInputs(
  tx: Tx,
  accountId: string,
  body: z.infer<typeof target>,
  issuer: string,
) {
  if (body.rationale != null || body.inputs != null)
    await requireBodyConsent(tx, accountId, issuer);
  if (body.inputs?.body_context && !(await readBody(tx, accountId)))
    throw invalidInput("body_context snapshot must refer to this profile's saved context");
  if (body.inputs?.weight) {
    const [row] = await tx
      .select({ id: weights.id })
      .from(weights)
      .where(and(eq(weights.id, body.inputs.weight.id), eq(weights.accountId, accountId)));
    if (!row) throw invalidInput("weight snapshot must refer to this profile's recorded weight");
  }
}
