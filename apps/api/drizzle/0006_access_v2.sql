-- ID-1: the clean break deletes all personal test data; catalogue tables are untouched.
TRUNCATE "request_results", "food_links", "weights", "day_targets", "targets", "recipe_ingredients", "entries", "recipes", "products", "meals", "grants", "connections", "accounts";--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"state" text,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "oauth_tokens_kind" CHECK ("oauth_tokens"."kind" IN ('access', 'refresh'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"firebase_uid" text NOT NULL,
	"display_name" text NOT NULL,
	"password_allowed" boolean DEFAULT false NOT NULL,
	"consent_version" text,
	"consent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_firebaseUid_unique" UNIQUE("firebase_uid")
);
--> statement-breakpoint
ALTER TABLE "request_results" DROP CONSTRAINT "request_results_connection_id_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "connections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "connections" CASCADE;--> statement-breakpoint
DROP TABLE "grants" CASCADE;--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_firebaseUid_unique";--> statement-breakpoint
ALTER TABLE "day_targets" DROP CONSTRAINT "day_targets_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "entries" DROP CONSTRAINT "entries_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "food_links" DROP CONSTRAINT "food_links_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "meals" DROP CONSTRAINT "meals_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "recipes" DROP CONSTRAINT "recipes_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "targets" DROP CONSTRAINT "targets_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "weights" DROP CONSTRAINT "weights_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "request_results" DROP CONSTRAINT "request_results_connection_id_request_id_pk";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "owner_user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "is_own" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "request_results" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "request_results" ADD CONSTRAINT "request_results_user_id_request_id_pk" PRIMARY KEY("user_id","request_id");--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_grants_user_id_index" ON "oauth_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_grant_id_index" ON "oauth_tokens" USING btree ("grant_id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_targets" ADD CONSTRAINT "day_targets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_links" ADD CONSTRAINT "food_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meals" ADD CONSTRAINT "meals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_results" ADD CONSTRAINT "request_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weights" ADD CONSTRAINT "weights_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_owner_name_unique" ON "accounts" USING btree ("owner_user_id",lower("display_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_one_own_diary" ON "accounts" USING btree ("owner_user_id") WHERE "accounts"."is_own";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "firebase_uid";--> statement-breakpoint
ALTER TABLE "request_results" DROP COLUMN "connection_id";