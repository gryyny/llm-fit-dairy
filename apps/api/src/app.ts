import "reflect-metadata";
import {
  ConsoleLogger,
  Module,
  StandardSchemaValidationPipe,
  type DynamicModule,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { createDb, DB } from "./db/client.js";
import { ApiExceptionFilter } from "./errors.js";
import { COMMIT, HealthController } from "./health.controller.js";
import { FIREBASE, type FirebaseVerifier } from "./access/firebase.js";
import { DiaryGuard, ManageGuard, RATE_LIMIT } from "./access/guards.js";
import { ManageController } from "./access/manage.controller.js";
import {
  APPS_CHALLENGE,
  ConnectController,
  OAUTH_CLIENTS,
  OAuthController,
  type OAuthClient,
} from "./access/oauth.js";
import { ISSUER } from "./access/tokens.js";
import { CatalogueController } from "./diary/catalogue.controller.js";
import { ProfilesController } from "./diary/profiles.controller.js";
import { MealsController } from "./diary/meals.controller.js";
import { ReadController } from "./diary/read.controller.js";
import { SavedController } from "./diary/saved.controller.js";
import { WriteService } from "./diary/writes.js";
import { McpController } from "./mcp/mcp.controller.js";

export interface AppOptions {
  pool: Pool;
  commit: string;
  firebase: FirebaseVerifier;
  /** Our public origin, `https://<host>`: the OAuth issuer; `<issuer>/mcp` is the resource (OA-1). */
  issuer: string;
  /** OA-2: provided OAuth clients, and the submission portal's domain-verification token (MC-4). */
  oauth: { clients: OAuthClient[]; appsChallenge?: string };
  /** OP-7: requests per user per minute on `/api/v1` (default 120). */
  rateLimitPerMinute?: number;
  /** Built website directory; served at `/` when present. */
  webDist?: string;
  logger?: boolean;
}

@Module({})
class AppModule {
  static forRoot(options: AppOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        ManageController,
        OAuthController,
        ConnectController,
        McpController,
        ProfilesController,
        ReadController,
        MealsController,
        SavedController,
        CatalogueController,
      ],
      providers: [
        { provide: DB, useValue: createDb(options.pool) },
        { provide: COMMIT, useValue: options.commit },
        { provide: FIREBASE, useValue: options.firebase },
        { provide: ISSUER, useValue: options.issuer },
        { provide: OAUTH_CLIENTS, useValue: options.oauth.clients },
        { provide: APPS_CHALLENGE, useValue: options.oauth.appsChallenge ?? null },
        { provide: RATE_LIMIT, useValue: options.rateLimitPerMinute ?? 120 },
        ManageGuard,
        DiaryGuard,
        WriteService,
      ],
    };
  }
}

/** OP-3: one JSON line per request with the route template only, never the concrete path or body. */
function logRequests(req: Request, res: Response, next: NextFunction): void {
  const started = performance.now();
  res.on("finish", () => {
    const route: unknown = req.route;
    const template =
      typeof route === "object" && route !== null && "path" in route ? String(route.path) : null;
    console.log(
      JSON.stringify({
        level: "info",
        method: req.method,
        route: template ?? (req.path.startsWith("/api") ? "unmatched" : "website"),
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
      }),
    );
  });
  next();
}

export async function createApp(options: AppOptions): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(options), {
    logger: options.logger === false ? false : new ConsoleLogger({ json: true }),
  });
  app.disable("x-powered-by");
  app.useBodyParser("json", { limit: "1mb" });
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.useGlobalFilters(new ApiExceptionFilter());
  if (options.logger !== false) app.use(logRequests);

  const webDist = options.webDist;
  if (webDist && existsSync(join(webDist, "index.html"))) {
    // AR-1/OA-5: website routes fall back to index.html; API, OAuth, discovery and MCP paths never do.
    const serverPaths = ["/api", "/oauth", "/.well-known", "/mcp"];
    const isServerPath = (path: string) =>
      serverPaths.some((p) => path === p || path.startsWith(`${p}/`));
    // OA-3: the consent screen, like every website page, may not be framed by another site.
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (!isServerPath(req.path)) {
        res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Referrer-Policy", "same-origin");
      }
      next();
    });
    app.useStaticAssets(webDist, { index: false, extensions: ["html"] });
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET" || isServerPath(req.path)) {
        next();
        return;
      }
      res.sendFile(join(webDist, "index.html"));
    });
  }
  return app;
}
