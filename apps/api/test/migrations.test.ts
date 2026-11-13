import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { expect, it } from "vitest";
import { createDb, runMigrations } from "../src/db/client.js";
import { createPool } from "./db.js";
import { retainProduct } from "../src/diary/records.js";
import { product as productSchema } from "../src/diary/schemas.js";

it.each([9, 11, 12, 13])(
  "upgrades migration %i without changing IDs, snapshots, notes or cached responses",
  async (migrationCount) => {
    const admin = createPool();
    const database = `diary_migration_${randomUUID().replaceAll("-", "")}`;
    const source = fileURLToPath(new URL("../drizzle", import.meta.url));
    const folder = await mkdtemp(join(tmpdir(), "diary-migrations-"));
    const url = new URL(
      process.env.TEST_DATABASE_URL ?? "postgres://diary:diary@127.0.0.1:5432/diary_test",
    );
    url.pathname = `/${database}`;
    const pool = new pg.Pool({ connectionString: url.toString() });
    try {
      await admin.query(`CREATE DATABASE "${database}"`);
      const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8")) as {
        entries: { tag: string }[];
      };
      const entries = journal.entries.slice(0, migrationCount);
      await mkdir(join(folder, "meta"));
      await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
      for (const entry of entries)
        await cp(join(source, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
      const db = createDb(pool);
      await migrate(db, { migrationsFolder: folder });
      const [user, profile, grant, product, meal, item, target, weight] = Array.from(
        { length: 8 },
        () => randomUUID(),
      );
      await pool.query(
        "INSERT INTO users (id,firebase_uid,display_name) VALUES ($1,$2,'Synthetic migration')",
        [user, randomUUID()],
      );
      await pool.query(
        "INSERT INTO accounts (id,owner_user_id,display_name) VALUES ($1,$2,'Synthetic migration')",
        [profile, user],
      );
      await pool.query(
        "INSERT INTO oauth_grants (id,user_id,client_id,resource,scope) VALUES ($1,$2,'chatgpt','https://diary.test/mcp','diary')",
        [grant, user],
      );
      await pool.query(
        "INSERT INTO products (id,account_id,name,basis_amount,basis_unit,nutrients,version) VALUES ($1,$2,'Old oats',100,'g','{\"energy_kcal\":370}',3)",
        [product, profile],
      );
      await pool.query("INSERT INTO meals (id,account_id,diary_date) VALUES ($1,$2,'2026-10-01')", [
        meal,
        profile,
      ]);
      await pool.query(
        "INSERT INTO entries (id,meal_id,account_id,position,name,quantity,unit,nutrients,source,note,product_id) VALUES ($1,$2,$4,0,'Old oats',60,'g','{\"energy_kcal\":222}','estimate','Synthetic',$3)",
        [item, meal, product, profile],
      );
      await pool.query(
        "INSERT INTO targets (id,account_id,kind,effective_from,values,note,version) VALUES ($1,$2,'normal','2026-10-01','{\"energy_kcal\":{\"value\":2000}}','Synthetic old target',4)",
        [target, profile],
      );
      await pool.query(
        "INSERT INTO weights (id,account_id,measured_on,value,unit) VALUES ($1,$2,'2026-10-01',80,'kg')",
        [weight, profile],
      );
      const cached = { product: { id: product, version: 3, name: "Old oats" } };
      await pool.query(
        "INSERT INTO request_results (grant_id,request_id,fingerprint,status,body) VALUES ($1,'old-request','old-fingerprint',201,$2)",
        [grant, JSON.stringify(cached)],
      );
      let verifyShared: (() => Promise<void>) | undefined;
      if (migrationCount === 13) {
        const profileIds = [profile, randomUUID(), randomUUID(), randomUUID()] as const;
        for (const id of profileIds.slice(1)) {
          const owner = randomUUID();
          await pool.query(
            "INSERT INTO users (id,firebase_uid,display_name) VALUES ($1,$2,'Synthetic migration peer')",
            [owner, randomUUID()],
          );
          await pool.query(
            "INSERT INTO accounts (id,owner_user_id,display_name) VALUES ($1,$2,'Synthetic migration peer')",
            [id, owner],
          );
        }
        const release = await pool.query<{ id: string }>(
          "INSERT INTO catalogue_release (source,release,archive_sha256,read_count,record_count,rejected_count,rejected_reasons) VALUES ('off','synthetic','synthetic',1,1,0,'{}') RETURNING id",
        );
        const published = await pool.query<{ id: number }>(
          "INSERT INTO catalogue_record (release_id,source_id,name,nutrients) VALUES ($1,'5901234123457','Synthetic publisher food','{\"energy_kcal\":200}') RETURNING id::int",
          [release.rows[0]?.id],
        );
        const recordId = published.rows[0]?.id;
        if (recordId === undefined) throw new Error("missing published fixture");
        const sourceBefore = (
          await pool.query("SELECT * FROM catalogue_record WHERE id=$1", [recordId])
        ).rows;
        const linked = [randomUUID(), randomUUID(), randomUUID()];
        for (const [n, id] of linked.entries())
          await pool.query(
            "INSERT INTO products (id,account_id,name,note,recognition_description,preferred_record_ids,barcode,gtin_key,food_kind,preparation,provenance,identity_key,basis_amount,basis_unit,nutrients,version) VALUES ($1,$2,$3,$4,$5,$6,'5901234123457','05901234123457','product','{\"state\":\"as_sold\",\"description\":null}',$7,'gtin:05901234123457',100,$8,$9,4)",
            [
              id,
              profileIds[n],
              `Synthetic personal ${n}`,
              `Private note ${n}`,
              `Private description ${n}`,
              [recordId],
              JSON.stringify({ source: "dataset", catalogue_record_id: recordId }),
              n === 1 ? "г" : "g",
              JSON.stringify({ energy_kcal: n === 2 ? 201 : 200 }),
            ],
          );
        const ambiguous = [randomUUID(), randomUUID()];
        for (const id of ambiguous)
          await pool.query(
            "INSERT INTO products (id,account_id,name,basis_amount,basis_unit,nutrients) VALUES ($1,$2,'Same ambiguous name',100,'g','{}')",
            [id, profile],
          );
        const recipeId = randomUUID();
        const ingredientIds = [randomUUID(), randomUUID()];
        await pool.query(
          "INSERT INTO recipes (id,account_id,name,note,servings,nutrients,partial_nutrients,version) VALUES ($1,$2,'Synthetic legacy soup','Private recipe note',2,'{\"energy_kcal\":400,\"fibre_g\":2}',ARRAY['fibre_g'],5)",
          [recipeId, profile],
        );
        for (const [n, id] of ingredientIds.entries())
          await pool.query(
            "INSERT INTO recipe_ingredients (id,recipe_id,position,name,quantity,unit,nutrients,source,note,product_id) VALUES ($1,$2,$3,$4,1,'portion',$5,'estimate',$6,$7)",
            [
              id,
              recipeId,
              n + 1,
              `Private ingredient ${n}`,
              JSON.stringify(n === 0 ? { energy_kcal: 200, fibre_g: 2 } : { energy_kcal: 200 }),
              `Private ingredient note ${n}`,
              n === 0 ? linked[0] : null,
            ],
          );
        const recipeEntryId = randomUUID();
        await pool.query(
          "INSERT INTO entries (id,meal_id,account_id,position,name,quantity,unit,nutrients,partial_nutrients,source,note,recipe_id) VALUES ($1,$2,$3,2,'Synthetic recipe portion',0.5,'recipe','{\"energy_kcal\":200,\"fibre_g\":1}',ARRAY['fibre_g'],'estimate','Private portion note',$4)",
          [recipeEntryId, meal, profile, recipeId],
        );
        const entryBefore = (await pool.query("SELECT * FROM entries WHERE id=$1", [recipeEntryId]))
          .rows;
        const personalBefore = (
          await pool.query(
            "SELECT id,account_id,name,note,recognition_description,preferred_record_ids,version,created_at,updated_at FROM products WHERE id=ANY($1::uuid[]) ORDER BY id",
            [linked],
          )
        ).rows;
        verifyShared = async () => {
          const links = (
            await pool.query<{ id: string; food_id: string; revision_id: string }>(
              "SELECT id,food_id,revision_id FROM products WHERE id=ANY($1::uuid[])",
              [linked],
            )
          ).rows;
          expect(new Set(links.map((r) => r.food_id)).size).toBe(1);
          expect(new Set(links.map((r) => r.revision_id)).size).toBe(2);
          expect(links.find((r) => r.id === linked[0])?.revision_id).toBe(
            links.find((r) => r.id === linked[1])?.revision_id,
          );
          expect(
            (
              await pool.query(
                "SELECT id,account_id,name,note,recognition_description,preferred_record_ids,version,created_at,updated_at FROM products WHERE id=ANY($1::uuid[]) ORDER BY id",
                [linked],
              )
            ).rows,
          ).toEqual(personalBefore);
          expect(
            new Set(
              (
                await pool.query<{ food_id: string }>(
                  "SELECT food_id FROM products WHERE id=ANY($1::uuid[])",
                  [ambiguous],
                )
              ).rows.map((r) => r.food_id),
            ).size,
          ).toBe(2);
          expect(
            (await pool.query("SELECT * FROM entries WHERE id=$1", [recipeEntryId])).rows,
          ).toEqual(
            entryBefore.map((r: Record<string, unknown>) => ({
              ...r,
              food_revision_id: recipeId,
              diary_only_reason: null,
            })),
          );
          expect(
            (
              await pool.query(
                "SELECT id,recipe_revision_id,product_revision_id FROM recipe_ingredients WHERE recipe_revision_id=$1 ORDER BY position",
                [recipeId],
              )
            ).rows,
          ).toEqual([
            {
              id: ingredientIds[0],
              recipe_revision_id: recipeId,
              product_revision_id: links.find((r) => r.id === linked[0])?.revision_id,
            },
            { id: ingredientIds[1], recipe_revision_id: recipeId, product_revision_id: null },
          ]);
          expect(
            (
              await pool.query("SELECT ingredient_details,note,version FROM recipes WHERE id=$1", [
                recipeId,
              ])
            ).rows,
          ).toEqual([
            {
              ingredient_details: Object.fromEntries(
                ingredientIds.map((id, n) => [
                  id,
                  { name: `Private ingredient ${n}`, note: `Private ingredient note ${n}` },
                ]),
              ),
              note: "Private recipe note",
              version: 5,
            },
          ]);
          const revisions = (await pool.query("SELECT content FROM food_revisions")).rows;
          expect(JSON.stringify(revisions)).not.toContain("Private");
          expect(
            (await pool.query("SELECT * FROM catalogue_record WHERE id=$1", [recordId])).rows,
          ).toEqual(sourceBefore);
          const adopted = await db.transaction((tx) =>
            retainProduct(
              tx,
              profileIds[3],
              productSchema.parse({
                name: "Another personal name",
                barcode: "5901234123457",
                food_kind: "product",
                preparation: { state: "as_sold" },
                provenance: { source: "dataset", catalogue_record_id: recordId },
                basis_amount: 100,
                basis_unit: "g",
                nutrients: { energy_kcal: 200 },
              }),
            ),
          );
          expect(adopted.product.revision_id).toBe(
            links.find((r) => r.id === linked[0])?.revision_id,
          );
        };
      }
      if (migrationCount >= 11) {
        await pool.query(
          'INSERT INTO body_contexts (account_id,height,age,activity,goal,version) VALUES ($1,\'{"value":178,"unit":"cm"}\',\'{"years":38,"as_of":"2026-10-01"}\',\'Synthetic walking\',\'Synthetic maintenance\',2)',
          [profile],
        );
        await pool.query(
          "UPDATE weights SET note='Synthetic birth date 1988-02-29, height 178 cm' WHERE id=$1",
          [weight],
        );
        await pool.query(
          "UPDATE targets SET rationale='Synthetic rationale', inputs=$2 WHERE id=$1",
          [
            target,
            JSON.stringify({
              body_context: {
                version: 2,
                fields: {
                  height: { value: 178, unit: "cm" },
                  age: { years: 38, as_of: "2026-10-01" },
                  activity: "Synthetic walking",
                  goal: "Synthetic maintenance",
                },
              },
            }),
          ],
        );
      }
      const bodyBefore =
        migrationCount >= 11
          ? (await pool.query("SELECT * FROM body_contexts WHERE account_id=$1", [profile])).rows
          : [];
      const targetsBefore = (await pool.query("SELECT * FROM targets WHERE id=$1", [target])).rows;
      const weightsBefore = (await pool.query("SELECT * FROM weights WHERE id=$1", [weight])).rows;
      const before = (await pool.query("SELECT * FROM entries WHERE id=$1", [item])).rows;
      await runMigrations(db);
      await verifyShared?.();
      expect((await pool.query("SELECT * FROM entries WHERE id=$1", [item])).rows).toEqual(
        before.map((row: Record<string, unknown>) => ({
          ...row,
          partial_nutrients: [],
          food_revision_id: product,
          diary_only_reason: null,
        })),
      );
      expect(
        (
          await pool.query(
            "SELECT p.id,p.version,v.content->'foodKind' AS food_kind,v.content->'preparation' AS preparation,v.content->'provenance' AS provenance,f.identity_key FROM products p JOIN food_revisions v ON v.id=p.revision_id JOIN food_definitions f ON f.id=p.food_id WHERE p.id=$1",
            [product],
          )
        ).rows,
      ).toEqual([
        {
          id: product,
          version: 3,
          food_kind: null,
          preparation: null,
          provenance: null,
          identity_key: null,
        },
      ]);
      expect((await pool.query("SELECT * FROM targets WHERE id=$1", [target])).rows).toEqual(
        migrationCount >= 11
          ? targetsBefore
          : targetsBefore.map((row: Record<string, unknown>) => ({
              ...row,
              rationale: null,
              inputs: null,
            })),
      );
      expect(
        (await pool.query("SELECT version,display_name FROM accounts WHERE id=$1", [profile])).rows,
      ).toEqual([{ version: 1, display_name: "Synthetic migration" }]);
      expect(
        (await pool.query("SELECT * FROM body_contexts WHERE account_id=$1", [profile])).rows,
      ).toEqual(
        bodyBefore.map((row: Record<string, unknown>) => ({ ...row, date_of_birth: null })),
      );
      expect((await pool.query("SELECT * FROM weights WHERE id=$1", [weight])).rows).toEqual(
        weightsBefore,
      );
      expect(
        (await pool.query("SELECT body,account_id FROM request_results WHERE grant_id=$1", [grant]))
          .rows,
      ).toEqual([{ body: cached, account_id: null }]);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.end();
      await rm(folder, { recursive: true, force: true });
    }
  },
);
