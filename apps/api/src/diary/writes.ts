import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import type { DiaryContext } from "../access/guards.js";
import { DB, type Db } from "../db/client.js";
import { requestResults } from "../db/schema.js";
import { ApiError, invalidInput } from "../errors.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** JSON with object keys sorted, so equal requests have equal fingerprints. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

/**
 * DA-9: every chat-data write runs here, after the guard has checked current authorization. The
 * result is stored per connection in the write's own transaction and replayed only for an identical
 * fingerprint (method, path with profile and target IDs, validated query and body).
 */
@Injectable()
export class WriteService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async run(
    caller: DiaryContext,
    req: Request,
    res: Response,
    query: unknown,
    status: number,
    write: (tx: Tx) => Promise<unknown>,
  ): Promise<unknown> {
    const grantId = caller.grantId;
    if (grantId === null)
      throw new Error("writes need a connection; DiaryGuard refuses website writes");
    const requestId = req.headers["idempotency-key"];
    if (typeof requestId !== "string" || !/^[\x21-\x7e]{1,200}$/.test(requestId)) {
      throw invalidInput(
        "Idempotency-Key header (the tool's request_id) is required: 1-200 visible ASCII characters",
      );
    }
    const path = req.originalUrl.split("?")[0];
    const body: unknown = req.body;
    const fingerprint = createHash("sha256")
      .update(canonical([req.method, path, query, body ?? null]))
      .digest("hex");

    const result = await this.db.transaction(async (tx) => {
      // Serializes concurrent attempts with one request ID, so a lost-response retry can never write twice.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${grantId}:${requestId}`}, 0))`,
      );
      const [stored] = await tx
        .select()
        .from(requestResults)
        .where(and(eq(requestResults.grantId, grantId), eq(requestResults.requestId, requestId)));
      if (stored) {
        if (stored.fingerprint !== fingerprint) {
          throw new ApiError(
            409,
            "request_id_reused",
            "This request_id was already used for a different request; use a new request_id for a new write",
          );
        }
        return { status: stored.status, body: stored.body };
      }
      if (caller.accountId !== null) {
        // Different connections may mutate the same diary; retain one consistent lock order.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`profile:${caller.accountId}`}, 0))`,
        );
      }
      const written = JSON.parse(JSON.stringify(await write(tx))) as unknown;
      await tx.insert(requestResults).values({
        grantId,
        accountId: caller.accountId,
        requestId,
        fingerprint,
        status,
        body: written,
      });
      return { status, body: written };
    });
    res.status(result.status);
    return result.body;
  }
}
