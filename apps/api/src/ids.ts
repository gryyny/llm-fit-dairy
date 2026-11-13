import { createHash, randomBytes } from "node:crypto";

/** DA-1: time-ordered UUIDv7 (RFC 9562) for personal rows. */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** OA-4: an opaque bearer token (`fda_` access, `fdr_` refresh) or code; only its SHA-256 is stored. */
export function newToken(prefix: string): { token: string; hash: string } {
  const token = `${prefix}${randomBytes(32).toString("base64url")}`;
  return { token, hash: sha256(token) };
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
