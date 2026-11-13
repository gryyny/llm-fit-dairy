-- ID-1: independent profiles replace owned diaries; personal and OAuth test data are reset again. Catalogue tables are untouched.
TRUNCATE "request_results", "food_links", "weights", "day_targets", "targets", "recipe_ingredients", "entries", "recipes", "products", "meals", "accounts", "oauth_tokens", "oauth_codes", "oauth_requests", "oauth_grants", "users";--> statement-breakpoint
CREATE TABLE "connection_invites" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_profiles" (
	"grant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_profiles_grant_id_account_id_pk" PRIMARY KEY("grant_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "request_results" DROP CONSTRAINT "request_results_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "accounts_owner_name_unique";--> statement-breakpoint
DROP INDEX "accounts_one_own_diary";--> statement-breakpoint
ALTER TABLE "request_results" DROP CONSTRAINT "request_results_user_id_request_id_pk";--> statement-breakpoint
ALTER TABLE "request_results" ADD COLUMN "grant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "request_results" ADD CONSTRAINT "request_results_grant_id_request_id_pk" PRIMARY KEY("grant_id","request_id");--> statement-breakpoint
ALTER TABLE "connection_invites" ADD CONSTRAINT "connection_invites_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_profiles" ADD CONSTRAINT "connection_profiles_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_profiles" ADD CONSTRAINT "connection_profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_invites_grant_id_index" ON "connection_invites" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "connection_profiles_account_id_index" ON "connection_profiles" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "request_results" ADD CONSTRAINT "request_results_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "is_own";--> statement-breakpoint
ALTER TABLE "request_results" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_ownerUserId_unique" UNIQUE("owner_user_id");