import { CONSENT_VERSION } from "./consent.js";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { and, eq, gt, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DB, type Db } from "../db/client.js";
import {
  accounts,
  connectionProfiles,
  oauthCodes,
  oauthGrants,
  oauthRequests,
  oauthTokens,
  users,
} from "../db/schema.js";
import { invalidInput, notFound } from "../errors.js";
import { newToken, sha256, UUID, uuidv7 } from "../ids.js";
import { CurrentCaller, ManageGuard, type Caller } from "./guards.js";
import { ISSUER, resourceOf } from "./tokens.js";

/** OA-2: a provided OAuth client; the secret exists only as its SHA-256. */
export interface OAuthClient {
  id: string;
  secretSha256: string;
  redirectUris: string[];
}

export const OAUTH_CLIENTS = Symbol("OAUTH_CLIENTS");
export const APPS_CHALLENGE = Symbol("APPS_CHALLENGE");

/** OA-3: the health-data notice a user agrees to; bump it when the notice changes. */

const SCOPE = "diary";
const REQUEST_SECONDS = 600;
const CODE_SECONDS = 60;
const ACCESS_SECONDS = 3600;
const REFRESH_SECONDS = 180 * 86_400;
/** A refresh token presented again within this window gets a fresh pair; later, it revokes the grant. */
const REUSE_GRACE_SECONDS = 60;

const seconds = (n: number) => new Date(Date.now() + n * 1000);

/**
 * OA-3: the pending request travels in an HttpOnly cookie set by `/oauth/authorize`, never in the
 * URL, so only the browser that started connecting can approve it.
 */
const CONNECT_COOKIE = "fd_connect";
const CONNECT_COOKIE_PATH = "/api/manage/oauth";

function connectRequestId(req: Request): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, value] = part.trim().split("=", 2);
    if (name === CONNECT_COOKIE && value && UUID.test(value)) return value;
  }
  return null;
}
const S256 = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

function redirectWith(uri: string, params: Record<string, string | null>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

function sameSecret(secret: string, sha256Hex: string): boolean {
  const given = createHash("sha256").update(secret).digest();
  const expected = Buffer.from(sha256Hex, "hex");
  return expected.length === given.length && timingSafeEqual(given, expected);
}

/** RFC 6749 §2.3.1: HTTP Basic with form-encoded parts, or `client_id`/`client_secret` in the body. */
function clientCredentials(req: Request, body: Record<string, unknown>) {
  const basic = /^Basic (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
  if (basic) {
    const pair = Buffer.from(basic, "base64").toString("utf8");
    const colon = pair.indexOf(":");
    if (colon < 0) return null;
    const formDecode = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));
    try {
      return { id: formDecode(pair.slice(0, colon)), secret: formDecode(pair.slice(colon + 1)) };
    } catch {
      return null;
    }
  }
  const { client_id: id, client_secret: secret } = body;
  return typeof id === "string" && typeof secret === "string" ? { id, secret } : null;
}

const authorizeQuery = z.object({
  response_type: z.string().optional(),
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  state: z.string().max(1000).optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
});

interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const decisionBody = z.strictObject({
  approve: z.boolean(),
  consent: z.boolean().optional(),
});

function errorPage(res: Response, message: string): void {
  res.status(400).type("text/plain").send(`${message}\nStart connecting again from ChatGPT.`);
}

/**
 * OA-1..OA-4: discovery, authorization, token and revocation endpoints for one provided client
 * (ChatGPT). Errors use the OAuth formats, not the API's `{code, message}`.
 */
@Controller()
export class OAuthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ISSUER) private readonly issuer: string,
    @Inject(OAUTH_CLIENTS) private readonly clients: OAuthClient[],
    @Inject(APPS_CHALLENGE) private readonly challenge: string | null,
  ) {}

  @Get([".well-known/oauth-protected-resource", ".well-known/oauth-protected-resource/mcp"])
  protectedResource() {
    return {
      resource: resourceOf(this.issuer),
      authorization_servers: [this.issuer],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
    };
  }

  @Get(".well-known/oauth-authorization-server")
  authorizationServer() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
    };
  }

  /** MC-4: the submission portal's domain-verification token, as plain text. */
  @Get(".well-known/openai-apps-challenge")
  appsChallenge(@Res() res: Response): void {
    if (this.challenge) res.type("text/plain").send(this.challenge);
    else res.status(404).json({ code: "not_found", message: "No challenge configured" });
  }

  /** OA-3: an unvalidated redirect URI is never redirected to. */
  @Get("oauth/authorize")
  async authorize(
    @Query({ schema: authorizeQuery }) q: z.infer<typeof authorizeQuery>,
    @Res() res: Response,
  ): Promise<void> {
    const client = this.clients.find((c) => c.id === q.client_id);
    if (!client || !q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
      errorPage(res, "This connection link is not valid.");
      return;
    }
    const redirectUri = q.redirect_uri;
    const fail = (error: string, description: string) => {
      res.redirect(
        302,
        redirectWith(redirectUri, {
          error,
          error_description: description,
          state: q.state ?? null,
          iss: this.issuer,
        }),
      );
    };
    if (q.response_type !== "code") {
      fail("unsupported_response_type", "Only the authorization code flow is supported");
      return;
    }
    if (q.code_challenge_method !== "S256" || !q.code_challenge || !S256.test(q.code_challenge)) {
      fail("invalid_request", "PKCE with S256 is required");
      return;
    }
    const resource = resourceOf(this.issuer);
    if (q.resource !== undefined && q.resource !== resource) {
      fail("invalid_target", "Unknown resource");
      return;
    }
    await this.db.delete(oauthRequests).where(lt(oauthRequests.expiresAt, sql`now()`));
    const id = uuidv7();
    await this.db.insert(oauthRequests).values({
      id,
      clientId: client.id,
      redirectUri,
      state: q.state ?? null,
      codeChallenge: q.code_challenge,
      resource,
      scope: SCOPE,
      expiresAt: seconds(REQUEST_SECONDS),
    });
    res.cookie(CONNECT_COOKIE, id, {
      httpOnly: true,
      secure: this.issuer.startsWith("https://"),
      sameSite: "lax",
      path: CONNECT_COOKIE_PATH,
      maxAge: REQUEST_SECONDS * 1000,
    });
    res.redirect(302, "/connect");
  }

  @Post("oauth/token")
  async token(@Req() req: Request, @Res() res: Response, @Body() raw: unknown): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const param = (name: string) => (typeof body[name] === "string" ? body[name] : undefined);
    const fail = (status: number, error: string, description: string) => {
      if (status === 401) res.setHeader("WWW-Authenticate", 'Basic realm="oauth"');
      res.status(status).json({ error, error_description: description });
    };
    const client = this.authenticateClient(req, body);
    if (!client) {
      fail(401, "invalid_client", "Client authentication failed");
      return;
    }
    const resource = param("resource");
    if (resource !== undefined && resource !== resourceOf(this.issuer)) {
      fail(400, "invalid_target", "Unknown resource");
      return;
    }

    if (param("grant_type") === "authorization_code") {
      const code = param("code");
      const verifier = param("code_verifier");
      const redirectUri = param("redirect_uri");
      if (!code || !verifier || !redirectUri) {
        fail(400, "invalid_request", "code, redirect_uri and code_verifier are required");
        return;
      }
      const [stored] = await this.db
        .delete(oauthCodes)
        .where(eq(oauthCodes.codeHash, sha256(code)))
        .returning();
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (
        !stored ||
        stored.expiresAt <= new Date() ||
        stored.clientId !== client.id ||
        stored.redirectUri !== redirectUri ||
        !VERIFIER.test(verifier) ||
        challenge !== stored.codeChallenge
      ) {
        fail(400, "invalid_grant", "The authorization code is invalid or expired");
        return;
      }
      const grantId = uuidv7();
      await this.db.transaction(async (tx) => {
        await tx.insert(oauthGrants).values({
          id: grantId,
          userId: stored.userId,
          clientId: client.id,
          resource: stored.resource,
          scope: stored.scope,
        });
        // ID-4: a new connection starts with the profile of the person who approved it.
        const [own] = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.ownerUserId, stored.userId));
        if (own) await tx.insert(connectionProfiles).values({ grantId, accountId: own.id });
      });
      res.status(200).json(await this.issueTokens(grantId));
      return;
    }

    if (param("grant_type") === "refresh_token") {
      const refreshToken = param("refresh_token");
      if (!refreshToken) {
        fail(400, "invalid_request", "refresh_token is required");
        return;
      }
      const result = await this.rotate(refreshToken, client.id);
      if (!result) {
        fail(400, "invalid_grant", "The refresh token is invalid, expired or revoked");
        return;
      }
      res.status(200).json(result);
      return;
    }
    fail(400, "unsupported_grant_type", "Use authorization_code or refresh_token");
  }

  /** RFC 7009: always 200; a refresh token revokes its whole connection. */
  @Post("oauth/revoke")
  async revoke(@Req() req: Request, @Res() res: Response, @Body() raw: unknown): Promise<void> {
    const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const client = this.authenticateClient(req, body);
    if (!client) {
      res.setHeader("WWW-Authenticate", 'Basic realm="oauth"');
      res
        .status(401)
        .json({ error: "invalid_client", error_description: "Client authentication failed" });
      return;
    }
    const token = typeof body.token === "string" ? body.token : "";
    const [row] = await this.db
      .select({
        kind: oauthTokens.kind,
        grantId: oauthTokens.grantId,
        clientId: oauthGrants.clientId,
      })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
      .where(eq(oauthTokens.tokenHash, sha256(token)));
    if (row?.clientId === client.id) {
      if (row.kind === "refresh") await this.revokeGrant(row.grantId);
      else await this.db.delete(oauthTokens).where(eq(oauthTokens.tokenHash, sha256(token)));
    }
    res.status(200).json({});
  }

  private authenticateClient(req: Request, body: Record<string, unknown>): OAuthClient | null {
    const credentials = clientCredentials(req, body);
    const client = this.clients.find((c) => c.id === credentials?.id);
    return client && credentials && sameSecret(credentials.secret, client.secretSha256)
      ? client
      : null;
  }

  private async issueTokens(grantId: string): Promise<TokenResponse> {
    const access = newToken("fda_");
    const refresh = newToken("fdr_");
    await this.db.insert(oauthTokens).values([
      { tokenHash: access.hash, grantId, kind: "access", expiresAt: seconds(ACCESS_SECONDS) },
      { tokenHash: refresh.hash, grantId, kind: "refresh", expiresAt: seconds(REFRESH_SECONDS) },
    ]);
    return {
      access_token: access.token,
      token_type: "Bearer" as const,
      expires_in: ACCESS_SECONDS,
      refresh_token: refresh.token,
      scope: SCOPE,
    };
  }

  /**
   * OA-4: each refresh token is rotated. Presenting a used one again within the grace window (a
   * retry after a lost response) issues another pair; after it, the connection is revoked, since
   * the token may have been stolen.
   */
  private async rotate(refreshToken: string, clientId: string): Promise<TokenResponse | null> {
    const hash = sha256(refreshToken);
    const [row] = await this.db
      .select({ token: oauthTokens, grant: oauthGrants })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
      .where(and(eq(oauthTokens.tokenHash, hash), eq(oauthTokens.kind, "refresh")));
    if (!row || row.grant.revokedAt || row.grant.clientId !== clientId) return null;
    if (row.token.expiresAt <= new Date()) return null;
    if (row.token.usedAt) {
      // A retry after a lost response gets a fresh pair; a later replay looks like theft.
      if (row.token.usedAt.getTime() < Date.now() - REUSE_GRACE_SECONDS * 1000) {
        await this.revokeGrant(row.grant.id);
        return null;
      }
    } else {
      const [claimed] = await this.db
        .update(oauthTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(oauthTokens.tokenHash, hash), sql`${oauthTokens.usedAt} IS NULL`))
        .returning();
      if (!claimed) return this.rotate(refreshToken, clientId);
    }
    await this.db
      .delete(oauthTokens)
      .where(
        and(
          eq(oauthTokens.grantId, row.grant.id),
          or(
            lt(oauthTokens.expiresAt, sql`now()`),
            and(
              isNotNull(oauthTokens.usedAt),
              lt(oauthTokens.usedAt, sql`now() - interval '1 day'`),
            ),
          ),
        ),
      );
    return this.issueTokens(row.grant.id);
  }

  private async revokeGrant(grantId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(oauthGrants)
        .set({ revokedAt: new Date() })
        .where(eq(oauthGrants.id, grantId));
      await tx.delete(oauthTokens).where(eq(oauthTokens.grantId, grantId));
    });
  }
}

/** OA-3: the website's side of `/connect`, with the signed-in person's Firebase ID token. */
@Controller("api/manage/oauth")
@UseGuards(ManageGuard)
export class ConnectController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ISSUER) private readonly issuer: string,
  ) {}

  @Get("request")
  async request(@CurrentCaller() caller: Caller, @Req() req: Request) {
    const requestId = connectRequestId(req);
    const [pending] = requestId
      ? await this.db
          .select()
          .from(oauthRequests)
          .where(and(eq(oauthRequests.id, requestId), gt(oauthRequests.expiresAt, sql`now()`)))
      : [];
    if (!pending) throw notFound("Connection request");
    const [user] = await this.db.select().from(users).where(eq(users.id, caller.userId));
    return {
      request: { client: pending.clientId, scope: pending.scope, expires_at: pending.expiresAt },
      consent_required: user?.consentVersion !== CONSENT_VERSION,
      consent_version: CONSENT_VERSION,
    };
  }

  /** Approval needs consent to the current notice unless already given; returns where to send the browser. */
  @Post("decision")
  @HttpCode(200)
  async decide(
    @CurrentCaller() caller: Caller,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: decisionBody }) body: z.infer<typeof decisionBody>,
  ) {
    const requestId = connectRequestId(req);
    if (!requestId) throw notFound("Connection request");
    const [user] = await this.db.select().from(users).where(eq(users.id, caller.userId));
    const consented = user?.consentVersion === CONSENT_VERSION;
    if (body.approve && !consented && body.consent !== true) {
      throw invalidInput("Agree to storing your diary records to connect ChatGPT");
    }
    const [pending] = await this.db
      .delete(oauthRequests)
      .where(and(eq(oauthRequests.id, requestId), gt(oauthRequests.expiresAt, sql`now()`)))
      .returning();
    if (!pending) throw notFound("Connection request");
    res.clearCookie(CONNECT_COOKIE, { path: CONNECT_COOKIE_PATH });
    const back = (params: Record<string, string>) => ({
      redirect_to: redirectWith(pending.redirectUri, {
        ...params,
        state: pending.state,
        iss: this.issuer,
      }),
    });
    if (!body.approve) return back({ error: "access_denied", error_description: "Not allowed" });
    if (!consented) {
      await this.db
        .update(users)
        .set({ consentVersion: CONSENT_VERSION, consentAt: new Date() })
        .where(eq(users.id, caller.userId));
    }
    await this.db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, sql`now()`));
    const code = newToken("fdc_");
    await this.db.insert(oauthCodes).values({
      codeHash: code.hash,
      userId: caller.userId,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      resource: pending.resource,
      scope: pending.scope,
      expiresAt: seconds(CODE_SECONDS),
    });
    return back({ code: code.token });
  }
}
