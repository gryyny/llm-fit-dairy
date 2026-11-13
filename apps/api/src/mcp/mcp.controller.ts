import { All, Controller, Inject, Req, Res } from "@nestjs/common";
import { createMcpHandler, originValidationResponse } from "@modelcontextprotocol/server";
import type { Request, Response } from "express";
import { bearer } from "../access/guards.js";
import { ISSUER, resourceOf, verifyAccessToken } from "../access/tokens.js";
import { DB, type Db } from "../db/client.js";
import { createServer, type DiaryApi } from "./tools.js";

/** Browser origins a request may carry; server-to-server calls without Origin pass. */
const CHATGPT_ORIGINS = ["chatgpt.com", "chat.openai.com"];

/** MC-1: tools call our own `/api/v1` on loopback with the caller's token, reusing its checks. */
function loopbackApi(base: string, token: string): DiaryApi {
  return {
    async request(method, path, options = {}) {
      const url = new URL(`${base}${path}`);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.requestId === undefined ? {} : { "Idempotency-Key": options.requestId }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "manual",
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        body: text ? (JSON.parse(text) as unknown) : null,
      };
    },
  };
}

/** The stateless MCP endpoint (MC-1); every request needs a valid OAuth access token (OA-5). */
@Controller("mcp")
export class McpController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ISSUER) private readonly issuer: string,
  ) {}

  @All()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const metadata = `${this.issuer}/.well-known/oauth-protected-resource/mcp`;
    const token = bearer(req);
    const access = token ? await verifyAccessToken(this.db, token, resourceOf(this.issuer)) : null;
    if (!token || !access) {
      res
        .status(401)
        .setHeader(
          "WWW-Authenticate",
          token
            ? `Bearer resource_metadata="${metadata}", error="invalid_token", error_description="The access token is invalid or expired"`
            : `Bearer resource_metadata="${metadata}", scope="diary"`,
        )
        .json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Authentication required" },
          id: null,
        });
      return;
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    const hasBody = req.method === "POST";
    const request = new Request(resourceOf(this.issuer), {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
    });
    const rejected = originValidationResponse(request, [
      ...CHATGPT_ORIGINS,
      new URL(this.issuer).hostname,
    ]);
    const api = loopbackApi(`http://127.0.0.1:${String(req.socket.localPort)}/api/v1`, token);
    const response =
      rejected ??
      (await createMcpHandler(() => createServer(api, metadata)).fetch(request, {
        parsedBody: hasBody ? (req.body as unknown) : undefined,
      }));
    res.status(response.status);
    response.headers.forEach((value, name) => {
      res.setHeader(name, value);
    });
    res.send(Buffer.from(await response.arrayBuffer()));
  }
}
