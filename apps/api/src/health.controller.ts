import { Controller, Get, Inject, Res } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Response } from "express";
import { DB, type Db } from "./db/client.js";

export const COMMIT = Symbol("COMMIT");

@Controller("api/health")
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(COMMIT) private readonly commit: string,
  ) {}

  @Get()
  async health(@Res({ passthrough: true }) res: Response) {
    try {
      await this.db.execute(sql`select 1`);
      return { status: "ok", commit: this.commit };
    } catch {
      res.status(503);
      return { status: "unavailable", commit: this.commit };
    }
  }
}
