ALTER TABLE "products" ADD COLUMN "food_kind" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "variant" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "recognition_description" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "preparation" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "identity_key" text;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "recognition_description" text;--> statement-breakpoint
ALTER TABLE "request_results" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "request_results" ADD CONSTRAINT "request_results_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_accountId_identityKey_unique" UNIQUE("account_id","identity_key");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_food_kind" CHECK ("products"."food_kind" IN ('basic', 'product'));