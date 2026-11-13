import pg from "pg";

/** Real PostgreSQL for integration tests (OP-5); CI sets TEST_DATABASE_URL. */
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://diary:diary@127.0.0.1:5432/diary_test";

export const createPool = () => new pg.Pool({ connectionString: testDatabaseUrl });
