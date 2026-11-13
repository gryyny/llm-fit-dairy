CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"firebase_uid" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_firebaseUid_unique" UNIQUE("firebase_uid")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"credential_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_publicId_unique" UNIQUE("public_id"),
	CONSTRAINT "connections_credentialHash_unique" UNIQUE("credential_hash")
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"connection_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grants_connection_id_account_id_pk" PRIMARY KEY("connection_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grants_account_id_index" ON "grants" USING btree ("account_id");