CREATE TABLE "images" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "images_owner_idx" ON "images" USING btree ("owner_id");