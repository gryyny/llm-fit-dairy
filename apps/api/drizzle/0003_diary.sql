CREATE TABLE "day_targets" (
	"account_id" uuid NOT NULL,
	"diary_date" date NOT NULL,
	"kind" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "day_targets_account_id_diary_date_pk" PRIMARY KEY("account_id","diary_date"),
	CONSTRAINT "day_targets_kind" CHECK ("day_targets"."kind" IN ('normal', 'training'))
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"meal_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"quantity" double precision NOT NULL,
	"unit" text NOT NULL,
	"nutrients" jsonb NOT NULL,
	"source" text NOT NULL,
	"note" text NOT NULL,
	"catalogue_record_id" bigint,
	"product_id" uuid,
	"label_basis_amount" double precision,
	"label_basis_unit" text,
	"label_nutrients" jsonb,
	"recipe_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entries_source" CHECK ("entries"."source" IN ('label', 'dataset', 'estimate'))
);
--> statement-breakpoint
CREATE TABLE "food_links" (
	"account_id" uuid NOT NULL,
	"record_a" bigint NOT NULL,
	"record_b" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_links_account_id_record_a_record_b_pk" PRIMARY KEY("account_id","record_a","record_b"),
	CONSTRAINT "food_links_order" CHECK ("food_links"."record_a" < "food_links"."record_b")
);
--> statement-breakpoint
CREATE TABLE "meals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"diary_date" date NOT NULL,
	"label" text,
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"barcode" text,
	"gtin_key" text,
	"basis_amount" double precision NOT NULL,
	"basis_unit" text NOT NULL,
	"nutrients" jsonb NOT NULL,
	"preferred_record_ids" bigint[] DEFAULT '{}' NOT NULL,
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_ingredients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipe_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"quantity" double precision NOT NULL,
	"unit" text NOT NULL,
	"nutrients" jsonb NOT NULL,
	"source" text NOT NULL,
	"note" text NOT NULL,
	"catalogue_record_id" bigint,
	"product_id" uuid,
	"label_basis_amount" double precision,
	"label_basis_unit" text,
	"label_nutrients" jsonb,
	CONSTRAINT "recipe_ingredients_source" CHECK ("recipe_ingredients"."source" IN ('label', 'dataset', 'estimate'))
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"yield_amount" double precision,
	"yield_unit" text,
	"servings" double precision,
	"nutrients" jsonb NOT NULL,
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_results" (
	"connection_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" integer NOT NULL,
	"body" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_results_connection_id_request_id_pk" PRIMARY KEY("connection_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"effective_from" date NOT NULL,
	"values" jsonb NOT NULL,
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "targets_accountId_kind_effectiveFrom_unique" UNIQUE("account_id","kind","effective_from"),
	CONSTRAINT "targets_kind" CHECK ("targets"."kind" IN ('normal', 'training'))
);
--> statement-breakpoint
CREATE TABLE "weights" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"measured_on" date NOT NULL,
	"value" double precision NOT NULL,
	"unit" text NOT NULL,
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weights_unit" CHECK ("weights"."unit" IN ('kg', 'lb'))
);
--> statement-breakpoint
ALTER TABLE "day_targets" ADD CONSTRAINT "day_targets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_meal_id_meals_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_catalogue_record_id_catalogue_record_id_fk" FOREIGN KEY ("catalogue_record_id") REFERENCES "public"."catalogue_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_links" ADD CONSTRAINT "food_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_links" ADD CONSTRAINT "food_links_record_a_catalogue_record_id_fk" FOREIGN KEY ("record_a") REFERENCES "public"."catalogue_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_links" ADD CONSTRAINT "food_links_record_b_catalogue_record_id_fk" FOREIGN KEY ("record_b") REFERENCES "public"."catalogue_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meals" ADD CONSTRAINT "meals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_catalogue_record_id_catalogue_record_id_fk" FOREIGN KEY ("catalogue_record_id") REFERENCES "public"."catalogue_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_results" ADD CONSTRAINT "request_results_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weights" ADD CONSTRAINT "weights_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entries_meal_id_index" ON "entries" USING btree ("meal_id");--> statement-breakpoint
CREATE INDEX "entries_account_id_index" ON "entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "food_links_account_id_record_b_index" ON "food_links" USING btree ("account_id","record_b");--> statement-breakpoint
CREATE INDEX "meals_account_id_diary_date_index" ON "meals" USING btree ("account_id","diary_date");--> statement-breakpoint
CREATE INDEX "products_account_id_index" ON "products" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "recipe_ingredients_recipe_id_index" ON "recipe_ingredients" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "recipes_account_id_index" ON "recipes" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "weights_account_id_measured_on_index" ON "weights" USING btree ("account_id","measured_on");