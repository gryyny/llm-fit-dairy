// CA-4: `node dist/import.js <source> <path> --release <label>`, run by hand once per archive.
import { parseArgs } from "node:util";
import pg from "pg";
import { z } from "zod";
import { createDb, runMigrations } from "./db/client.js";
import { importCatalogue, sources } from "./catalogue/import/index.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { release: { type: "string" } },
});
const args = z
  .object({
    source: z.enum(sources),
    path: z.string().min(1),
    release: z.string().min(1),
  })
  .safeParse({ source: positionals[0], path: positionals[1], release: values.release });
if (!args.success) {
  console.error(`Usage: import <${sources.join("|")}> <path> --release <label>`);
  process.exit(2);
}

const { DATABASE_URL } = z.object({ DATABASE_URL: z.string().min(1) }).parse(process.env);
const pool = new pg.Pool({ connectionString: DATABASE_URL });
try {
  await runMigrations(createDb(pool));
  const started = performance.now();
  const result = await importCatalogue(pool, args.data.source, args.data.path, args.data.release);
  const seconds = Math.round((performance.now() - started) / 1000);
  const peakRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
  console.log(JSON.stringify({ ...result, seconds, peakRssMb }, null, 2));
} finally {
  await pool.end();
}
