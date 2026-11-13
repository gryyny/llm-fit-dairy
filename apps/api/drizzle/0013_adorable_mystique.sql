CREATE TABLE "food_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identity_key" text,
	CONSTRAINT "food_definitions_identityKey_unique" UNIQUE("identity_key")
);
--> statement-breakpoint
CREATE TABLE "food_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"food_id" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"catalogue_record_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_revisions_foodId_fingerprint_unique" UNIQUE("food_id","fingerprint"),
	CONSTRAINT "food_revisions_foodId_id_unique" UNIQUE("food_id","id")
);
--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_accountId_identityKey_unique";--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_food_kind";--> statement-breakpoint
ALTER TABLE "recipe_ingredients" DROP CONSTRAINT "recipe_ingredients_recipe_id_recipes_id_fk";
--> statement-breakpoint
ALTER TABLE "recipe_ingredients" DROP CONSTRAINT "recipe_ingredients_product_id_products_id_fk";
--> statement-breakpoint
DROP INDEX "recipe_ingredients_recipe_id_index";--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "food_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "diary_only_reason" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "food_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "revision_id" uuid;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "recipe_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "product_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "food_id" uuid;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "revision_id" uuid;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "ingredient_details" jsonb;--> statement-breakpoint
-- Keep ambiguous legacy identities separate; only existing trusted keys converge.
CREATE TEMP TABLE product_migration ON COMMIT DROP AS
WITH facts AS (
  SELECT id AS link_id, identity_key,
    first_value(id) OVER (PARTITION BY coalesce(identity_key, id::text) ORDER BY id) AS food_id,
    jsonb_build_object('kind','product','brand',brand,'barcode',barcode,'gtinKey',gtin_key,
      'foodKind',food_kind,'variant',variant,'preparation',preparation,'provenance',provenance,
      'basisAmount',basis_amount,'basisUnit',basis_unit,'nutrients',nutrients) AS content,
    created_at
  FROM products
), compared AS (
  SELECT *, (CASE WHEN identity_key LIKE 'gtin:%' THEN content - 'barcode' - 'gtinKey' ELSE content END) || jsonb_build_object(
    'basisUnit', CASE lower(trim(content->>'basisUnit'))
      WHEN 'г' THEN 'g' WHEN 'g' THEN 'g' WHEN 'кг' THEN 'kg' WHEN 'kg' THEN 'kg'
      WHEN 'мл' THEN 'ml' WHEN 'ml' THEN 'ml' WHEN 'л' THEN 'l' WHEN 'l' THEN 'l' ELSE content->>'basisUnit' END,
    'provenance', CASE WHEN content->'provenance'->>'source'='label' THEN
      jsonb_set(content->'provenance','{label,basis_unit}',to_jsonb(CASE lower(trim(content->'provenance'->'label'->>'basis_unit'))
        WHEN 'г' THEN 'g' WHEN 'g' THEN 'g' WHEN 'кг' THEN 'kg' WHEN 'kg' THEN 'kg'
        WHEN 'мл' THEN 'ml' WHEN 'ml' THEN 'ml' WHEN 'л' THEN 'l' WHEN 'l' THEN 'l'
        ELSE content->'provenance'->'label'->>'basis_unit' END)) ELSE content->'provenance' END) AS comparison
  FROM facts
), hashed AS (
  SELECT *, encode(sha256(convert_to(comparison::text,'UTF8')),'hex') AS fingerprint FROM compared
)
SELECT *, first_value(link_id) OVER (PARTITION BY food_id,fingerprint ORDER BY link_id) AS revision_id FROM hashed;
--> statement-breakpoint
INSERT INTO food_definitions (id,identity_key) SELECT DISTINCT food_id,identity_key FROM product_migration;
--> statement-breakpoint
INSERT INTO food_revisions (id,food_id,content,fingerprint,catalogue_record_id,created_at)
SELECT revision_id,food_id,content,fingerprint,
  CASE WHEN content->'provenance'->>'source'='dataset' THEN (content->'provenance'->>'catalogue_record_id')::bigint END, created_at
FROM product_migration WHERE link_id=revision_id;
--> statement-breakpoint
UPDATE products p SET food_id=m.food_id,revision_id=m.revision_id FROM product_migration m WHERE p.id=m.link_id;
--> statement-breakpoint
UPDATE recipe_ingredients i SET recipe_revision_id=recipe_id,product_revision_id=p.revision_id
FROM products p WHERE i.product_id=p.id;
--> statement-breakpoint
UPDATE recipe_ingredients SET recipe_revision_id=recipe_id WHERE recipe_revision_id IS NULL;
--> statement-breakpoint
INSERT INTO food_definitions (id) SELECT id FROM recipes;
--> statement-breakpoint
INSERT INTO food_revisions (id,food_id,content,fingerprint,created_at)
SELECT r.id,r.id,c.content,encode(sha256(convert_to((c.content || jsonb_build_object('ingredients',coalesce(i.items,'[]'::jsonb)))::text,'UTF8')),'hex'),r.created_at
FROM recipes r CROSS JOIN LATERAL (
  SELECT jsonb_build_object('kind','recipe','yieldAmount',r.yield_amount,'yieldUnit',r.yield_unit,
    'servings',r.servings,'nutrients',r.nutrients,'partialNutrients',r.partial_nutrients) AS content
) c LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('position',position,'quantity',quantity,'unit',unit,'nutrients',nutrients,
    'partialNutrients',partial_nutrients,'source',source,'catalogueRecordId',catalogue_record_id,
    'labelBasisAmount',label_basis_amount,'labelBasisUnit',label_basis_unit,'labelNutrients',label_nutrients,
    'productRevisionId',product_revision_id) ORDER BY position) AS items
  FROM recipe_ingredients WHERE recipe_id=r.id
) i ON true;
--> statement-breakpoint
UPDATE recipes r SET food_id=id,revision_id=id,ingredient_details=coalesce((
  SELECT jsonb_object_agg(i.id::text,jsonb_build_object('name',i.name,'note',i.note))
  FROM recipe_ingredients i WHERE i.recipe_id=r.id
),'{}'::jsonb);
--> statement-breakpoint
UPDATE entries e SET food_revision_id=p.revision_id FROM products p WHERE e.product_id=p.id;
--> statement-breakpoint
UPDATE entries e SET food_revision_id=r.revision_id FROM recipes r WHERE e.recipe_id=r.id;
--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "food_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "revision_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ALTER COLUMN "recipe_revision_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "recipes" ALTER COLUMN "food_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "recipes" ALTER COLUMN "revision_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "recipes" ALTER COLUMN "ingredient_details" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "food_revisions" ADD CONSTRAINT "food_revisions_food_id_food_definitions_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."food_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_revisions" ADD CONSTRAINT "food_revisions_catalogue_record_id_catalogue_record_id_fk" FOREIGN KEY ("catalogue_record_id") REFERENCES "public"."catalogue_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_food_revision_id_food_revisions_id_fk" FOREIGN KEY ("food_revision_id") REFERENCES "public"."food_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_food_id_revision_id_food_revisions_food_id_id_fk" FOREIGN KEY ("food_id","revision_id") REFERENCES "public"."food_revisions"("food_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_revision_id_food_revisions_id_fk" FOREIGN KEY ("recipe_revision_id") REFERENCES "public"."food_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_product_revision_id_food_revisions_id_fk" FOREIGN KEY ("product_revision_id") REFERENCES "public"."food_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_food_id_revision_id_food_revisions_food_id_id_fk" FOREIGN KEY ("food_id","revision_id") REFERENCES "public"."food_revisions"("food_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipe_ingredients_recipe_revision_id_index" ON "recipe_ingredients" USING btree ("recipe_revision_id");--> statement-breakpoint
CREATE INDEX "recipe_ingredients_product_revision_id_index" ON "recipe_ingredients" USING btree ("product_revision_id");--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "brand";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "barcode";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "gtin_key";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "food_kind";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "variant";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "preparation";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "provenance";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "identity_key";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "basis_amount";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "basis_unit";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "nutrients";--> statement-breakpoint
ALTER TABLE "recipe_ingredients" DROP COLUMN "recipe_id";--> statement-breakpoint
ALTER TABLE "recipe_ingredients" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "recipe_ingredients" DROP COLUMN "note";--> statement-breakpoint
ALTER TABLE "recipe_ingredients" DROP COLUMN "product_id";--> statement-breakpoint
ALTER TABLE "recipes" DROP COLUMN "yield_amount";--> statement-breakpoint
ALTER TABLE "recipes" DROP COLUMN "yield_unit";--> statement-breakpoint
ALTER TABLE "recipes" DROP COLUMN "servings";--> statement-breakpoint
ALTER TABLE "recipes" DROP COLUMN "nutrients";--> statement-breakpoint
ALTER TABLE "recipes" DROP COLUMN "partial_nutrients";--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_accountId_foodId_unique" UNIQUE("account_id","food_id");--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_accountId_foodId_unique" UNIQUE("account_id","food_id");
