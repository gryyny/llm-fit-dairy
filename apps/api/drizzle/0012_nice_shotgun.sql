ALTER TABLE "entries" ADD COLUMN "partial_nutrients" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "partial_nutrients" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "partial_nutrients" text[] DEFAULT '{}' NOT NULL;