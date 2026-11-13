CREATE TABLE "catalogue_record" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "catalogue_record_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"release_id" bigint NOT NULL,
	"source_id" text NOT NULL,
	"name" text,
	"name_en" text,
	"brand" text,
	"barcode" text,
	"gtin_key" text,
	"nutrient_basis" text,
	"serving_basis" text,
	"preparation" text,
	"nutrients" jsonb NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(name_en, '') || ' ' || coalesce(brand, ''))) STORED,
	CONSTRAINT "catalogue_record_releaseId_sourceId_unique" UNIQUE("release_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "catalogue_release" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "catalogue_release_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"release" text NOT NULL,
	"archive_sha256" text NOT NULL,
	"read_count" bigint NOT NULL,
	"record_count" bigint NOT NULL,
	"rejected_count" bigint NOT NULL,
	"rejected_reasons" jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalogue_release_source_release_unique" UNIQUE("source","release")
);
--> statement-breakpoint
CREATE TABLE "nutrient_definition" (
	"release_id" bigint NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"unit" text,
	CONSTRAINT "nutrient_definition_release_id_code_pk" PRIMARY KEY("release_id","code")
);
--> statement-breakpoint
ALTER TABLE "catalogue_record" ADD CONSTRAINT "catalogue_record_release_id_catalogue_release_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."catalogue_release"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nutrient_definition" ADD CONSTRAINT "nutrient_definition_release_id_catalogue_release_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."catalogue_release"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalogue_record_gtin_key_index" ON "catalogue_record" USING btree ("gtin_key");--> statement-breakpoint
CREATE INDEX "catalogue_record_barcode_index" ON "catalogue_record" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "catalogue_record_search_index" ON "catalogue_record" USING gin ("search");