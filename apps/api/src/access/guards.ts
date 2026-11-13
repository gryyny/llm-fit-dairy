import {
  createParamDecorator,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { Request } from "express";
import { DB, type Db } from "../db/client.js";
import { accounts, connectionProfiles, users } from "../db/schema.js";
import { ApiError } from "../errors.js";
import { UUID, uuidv7 } from "../ids.js";
import { FIREBASE, type FirebaseVerifier, type VerifiedUser } from "./firebase.js";
import { ISSUER, resourceOf, verifyAccessToken } from "./tokens.js";

export interface Caller {
  userId: string;
  firebaseUid: string;
  displayName: string;
}

export interface DiaryContext {
  userId: string;
  /** The ChatGPT connection behind an OAuth token; null for the website's read-only sign-in. */
  grantId: string | null;
  /** The profile named in the route, when it has one. */
  accountId: string | null;
}

/** Nest injection token for OP-7's per-user request limit per minute. */
export const RATE_LIMIT = Symbol("RATE_LIMIT");

const callers = new WeakMap<Request, Caller>();
const diaries = new WeakMap<Request, DiaryContext>();

const invalidCredential = () =>
  new ApiError(401, "invalid_credential", "Missing or invalid credential");
const profileNotAvailable = () =>
  new ApiError(403, "profile_not_available", "This profile is not available here");

export function bearer(req: Request): string | null {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
  return match?.[1] ?? null;
}

/** ID-3: Google and password sign-ins create one profile per verified Firebase UID. */
async function signInUser(db: Db, verified: VerifiedUser): Promise<Caller> {
  if (verified.provider !== "password" && verified.provider !== "google.com") {
    throw new ApiError(403, "forbidden", "Sign in with Google or email and password");
  }
  const [user] = await db
    .insert(users)
    .values({ id: uuidv7(), firebaseUid: verified.uid, displayName: verified.name ?? "Me" })
    .onConflictDoUpdate({
      target: users.firebaseUid,
      set: { displayName: sql`coalesce(${verified.name}, ${users.displayName})` },
    })
    .returning();
  if (!user) throw new Error("user upsert returned no row");
  await db
    .insert(accounts)
    .values({ id: uuidv7(), ownerUserId: user.id, displayName: user.displayName })
    .onConflictDoNothing({ target: accounts.ownerUserId });
  return { userId: user.id, firebaseUid: user.firebaseUid, displayName: user.displayName };
}

/** AC-5: `/api/manage` accepts only Firebase ID tokens. */
@Injectable()
export class ManageGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(FIREBASE) private readonly firebase: FirebaseVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const token = bearer(req);
    const verified = token ? await this.firebase.verify(token) : null;
    if (!verified) throw invalidCredential();
    callers.set(req, await signInUser(this.db, verified));
    return true;
  }
}

/**
 * ID-3/OA-5: `/api/v1` accepts OAuth access tokens, reaching the profiles linked to their connection,
 * and, for reads only, the website's Firebase ID token, reaching the person's own profile. Unknown and
 * unreachable profiles are indistinguishable.
 */
@Injectable()
export class DiaryGuard implements CanActivate {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(FIREBASE) private readonly firebase: FirebaseVerifier,
    @Inject(ISSUER) private readonly issuer: string,
    @Inject(RATE_LIMIT) private readonly perMinute: number,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const caller = await this.authenticate(req);
    this.limit(caller.grantId ?? caller.userId);
    const profileId = req.params.profileId;
    if (profileId !== undefined) {
      if (typeof profileId !== "string" || !UUID.test(profileId)) throw profileNotAvailable();
      const [reachable] = caller.grantId
        ? await this.db
            .select({ id: connectionProfiles.accountId })
            .from(connectionProfiles)
            .where(
              and(
                eq(connectionProfiles.grantId, caller.grantId),
                eq(connectionProfiles.accountId, profileId),
              ),
            )
        : await this.db
            .select({ id: accounts.id })
            .from(accounts)
            .where(and(eq(accounts.id, profileId), eq(accounts.ownerUserId, caller.userId)));
      if (!reachable) throw profileNotAvailable();
    }
    diaries.set(req, { ...caller, accountId: profileId ?? null });
    return true;
  }

  /** OP-7: a fixed one-minute window per connection or website user, in this process. */
  private limit(key: string): void {
    const now = Date.now();
    if (this.windows.size > 10_000) {
      for (const [id, w] of this.windows) if (now - w.start >= 60_000) this.windows.delete(id);
    }
    const window = this.windows.get(key);
    if (!window || now - window.start >= 60_000) {
      this.windows.set(key, { start: now, count: 1 });
      return;
    }
    window.count += 1;
    if (window.count > this.perMinute) {
      throw new ApiError(429, "rate_limited", "Too many requests; wait a minute and try again");
    }
  }

  private async authenticate(req: Request): Promise<{ userId: string; grantId: string | null }> {
    const token = bearer(req);
    if (!token) throw invalidCredential();
    if (token.startsWith("fda_")) {
      const access = await verifyAccessToken(this.db, token, resourceOf(this.issuer));
      if (!access) throw invalidCredential();
      return access;
    }
    const verified = await this.firebase.verify(token);
    if (!verified) throw invalidCredential();
    if (req.method !== "GET") {
      throw new ApiError(
        403,
        "forbidden",
        "The website only reads diaries; changes are made in chat",
      );
    }
    return { userId: (await signInUser(this.db, verified)).userId, grantId: null };
  }
}

export const CurrentCaller = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const caller = callers.get(context.switchToHttp().getRequest<Request>());
  if (!caller) throw new Error("ManageGuard did not run");
  return caller;
});

export const CurrentDiary = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const diary = diaries.get(context.switchToHttp().getRequest<Request>());
  if (!diary) throw new Error("DiaryGuard did not run");
  return diary;
});
