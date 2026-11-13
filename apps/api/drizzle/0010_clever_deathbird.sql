CREATE TABLE "body_contexts" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"height" jsonb,
	"age" jsonb,
	"activity" text,
	"goal" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "rationale" text;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "inputs" jsonb;--> statement-breakpoint
ALTER TABLE "body_contexts" ADD CONSTRAINT "body_contexts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;