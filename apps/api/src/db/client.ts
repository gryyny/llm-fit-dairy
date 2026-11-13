import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

/** Nest injection token for the Drizzle database. */
export const DB = Symbol("DB");

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema, casing: "snake_case" });
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}
