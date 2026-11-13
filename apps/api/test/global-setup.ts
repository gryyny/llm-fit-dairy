import { createDb, runMigrations } from "../src/db/client.js";
import { createPool } from "./db.js";

export default async function setup(): Promise<void> {
  const pool = createPool();
  try {
    await pool.query(
      "drop schema if exists public cascade; drop schema if exists drizzle cascade;",
    );
    await pool.query("create schema public");
    await runMigrations(createDb(pool));
  } finally {
    await pool.end();
  }
}
