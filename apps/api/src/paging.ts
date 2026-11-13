import { createHash } from "node:crypto";
import { z } from "zod";
import { invalidInput } from "./errors.js";

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  complete: boolean;
}

/** What a cursor is bound to: the account and the exact query it continues (paging contract). */
export function cursorBinding(accountId: string, query: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([accountId, query]))
    .digest("base64url");
}

const cursorSchema = z.object({ b: z.string(), p: z.unknown() });

const uuid = z.uuid();
const date = z.iso.date();
/** Cursor positions per ordering; checked before any value reaches SQL. */
export const positions = {
  id: z.tuple([uuid]),
  foodName: z.tuple([z.string().max(200), z.enum(["product", "recipe"]), uuid]),
  foodRecent: z.tuple([
    z
      .string()
      .max(32)
      .regex(/^\d+(\.\d+)?$/),
    z.enum(["product", "recipe"]),
    uuid,
  ]),
  dateId: z.tuple([date, uuid]),
  rankId: z.tuple([
    z
      .string()
      .regex(/^\d+(\.\d+)?(e[-+]?\d+)?$/)
      // Zero or a normal PostgreSQL `real`; anything else would make the `::real` cast fail.
      .refine((rank) => {
        const value = Number(rank);
        if (value === 0) return /^[0.]+(e[-+]?\d+)?$/.test(rank); // "1e-999999" is 0 here but underflows there
        return value >= 1.17549435e-38 && value <= 3.4028234e38;
      }),
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ]),
};

export function encodeCursor(binding: string, position: (string | number)[]): string {
  return Buffer.from(JSON.stringify({ b: binding, p: position })).toString("base64url");
}

/** Returns the position a cursor continues from; a cursor from another account or query is refused. */
export function decodeCursor<T>(binding: string, cursor: string, position: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidInput("cursor is not valid");
  }
  const result = cursorSchema.safeParse(parsed);
  if (!result.success || result.data.b !== binding) {
    throw invalidInput("cursor does not belong to this account and query");
  }
  const checked = position.safeParse(result.data.p);
  if (!checked.success) throw invalidInput("cursor is not valid");
  return checked.data;
}
