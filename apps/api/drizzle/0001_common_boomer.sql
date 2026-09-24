CREATE TABLE "burns" (
	"id" serial PRIMARY KEY NOT NULL,
	"launch_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"spent_micro" bigint NOT NULL,
	"tokens" numeric(78, 0) NOT NULL,
	"buy_tx_sig" text,
	"burn_tx_sig" text
);
--> statement-breakpoint
CREATE TABLE "launches" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"dev_wallet" text NOT NULL,
	"name" text NOT NULL,
	"ticker" text NOT NULL,
	"description" text NOT NULL,
	"logo_url" text,
	"website" text,
	"twitter" text,
	"telegram" text,
	"creator_tax_bps" integer NOT NULL,
	"strategy" text,
	"instructions" text,
	"state" text NOT NULL,
	"launch_tx_sig" text,
	"failure_reason" text,
	"activation_micro" bigint NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"launched_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "burns" ADD CONSTRAINT "burns_launch_id_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."launches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "burns" ADD CONSTRAINT "burns_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "burns_launch_idx" ON "burns" USING btree ("launch_id","id");--> statement-breakpoint
CREATE INDEX "burns_agent_idx" ON "burns" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "launches_agent_uq" ON "launches" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "launches_state_created_idx" ON "launches" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "launches_dev_idx" ON "launches" USING btree ("dev_wallet");