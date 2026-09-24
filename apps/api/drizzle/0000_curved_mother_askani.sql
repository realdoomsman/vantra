CREATE TABLE "agent_keys" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"pubkey" text NOT NULL,
	"secret_enc" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_wallet" text NOT NULL,
	"owner_kind" text DEFAULT 'wallet' NOT NULL,
	"tier" text,
	"purchase_id" text,
	"status" text DEFAULT 'spawning' NOT NULL,
	"born_at" timestamp with time zone DEFAULT now() NOT NULL,
	"died_at" timestamp with time zone,
	"death_cause" text,
	"directive" text NOT NULL,
	"enabled_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text NOT NULL,
	"effort" text DEFAULT 'medium' NOT NULL,
	"heartbeat_min" integer DEFAULT 60 NOT NULL,
	"wallet_pubkey" text NOT NULL,
	"deploy_slug" text NOT NULL,
	"container_id" text,
	"treasury_micro" bigint DEFAULT 0 NOT NULL,
	"funding_micro" bigint DEFAULT 0 NOT NULL,
	"revenue_external_micro" bigint DEFAULT 0 NOT NULL,
	"revenue_internal_micro" bigint DEFAULT 0 NOT NULL,
	"revenue_pending_micro" bigint DEFAULT 0 NOT NULL,
	"spend_inference_micro" bigint DEFAULT 0 NOT NULL,
	"spend_compute_micro" bigint DEFAULT 0 NOT NULL,
	"spend_tools_micro" bigint DEFAULT 0 NOT NULL,
	"spend_hosting_micro" bigint DEFAULT 0 NOT NULL,
	"spend_rent_micro" bigint DEFAULT 0 NOT NULL,
	"spend_gas_micro" bigint DEFAULT 0 NOT NULL,
	"spend_payments_micro" bigint DEFAULT 0 NOT NULL,
	"royalty_in_micro" bigint DEFAULT 0 NOT NULL,
	"royalty_out_micro" bigint DEFAULT 0 NOT NULL,
	"recapitalized_micro" bigint DEFAULT 0 NOT NULL,
	"withdrawn_micro" bigint DEFAULT 0 NOT NULL,
	"onchain_usdc_micro" bigint DEFAULT 0 NOT NULL,
	"onchain_checked_at" timestamp with time zone,
	"total_steps" integer DEFAULT 0 NOT NULL,
	"last_step_at" timestamp with time zone,
	"next_step_at" timestamp with time zone,
	"sleep_until" timestamp with time zone,
	"last_rent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_settled_at" timestamp with time zone,
	"unsettled_micro" bigint DEFAULT 0 NOT NULL,
	"trade_realized_micro" bigint DEFAULT 0 NOT NULL,
	"trade_volume_micro" bigint DEFAULT 0 NOT NULL,
	"creator_reward_micro" bigint DEFAULT 0 NOT NULL,
	"token_mint" text,
	"token_curve" text,
	"token_creator_tax_bps" integer,
	"token_ticker" text,
	"token_name" text,
	"token_launched_at" timestamp with time zone,
	"current_step_id" bigint,
	"memory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"strategy" text,
	"share_strategy" boolean DEFAULT false NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"postmortem" text,
	"forked_from" text,
	"generation" integer DEFAULT 1 NOT NULL,
	"revivals" integer DEFAULT 0 NOT NULL,
	"paused_by_owner" boolean DEFAULT false NOT NULL,
	"spawn_error" text,
	"spawn_attempts" integer DEFAULT 0 NOT NULL,
	"last_deposit_sig" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"wallet" text PRIMARY KEY NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bounties" (
	"id" text PRIMARY KEY NOT NULL,
	"poster_type" text NOT NULL,
	"poster_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"reward_micro" bigint NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"claimer_agent_id" text,
	"submission" text,
	"feedback" text,
	"rejections" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"escrow_tx" text,
	"claimed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"step_id" bigint,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"slug" text NOT NULL,
	"dir_size_bytes" bigint DEFAULT 0 NOT NULL,
	"deployed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deposits_seen" (
	"sig" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"from_wallet" text NOT NULL,
	"amount_micro" bigint NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"classified" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"agent_id" text,
	"agent_name" text,
	"text" text NOT NULL,
	"amount_micro" bigint,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"parent_agent_id" text NOT NULL,
	"child_agent_id" text NOT NULL,
	"royalty_bps" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"royalties_paid_micro" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"amount_micro" bigint NOT NULL,
	"balance_after_micro" bigint NOT NULL,
	"memo" text DEFAULT '' NOT NULL,
	"tx_sig" text,
	"counterparty" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owner_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"from_role" text NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool" (
	"id" integer PRIMARY KEY NOT NULL,
	"wallet_pubkey" text NOT NULL,
	"usdc_micro" bigint DEFAULT 0 NOT NULL,
	"eth_gwei" bigint DEFAULT 0 NOT NULL,
	"eth_price_usd" numeric(14, 4) DEFAULT 0 NOT NULL,
	"agents_funded" integer DEFAULT 0 NOT NULL,
	"funded_micro" bigint DEFAULT 0 NOT NULL,
	"purchases_micro" bigint DEFAULT 0 NOT NULL,
	"founder_fees_micro" bigint DEFAULT 0 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pool_snapshots" (
	"day" date PRIMARY KEY NOT NULL,
	"usdc_micro" bigint DEFAULT 0 NOT NULL,
	"eth_gwei" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_txs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"amount_micro" bigint NOT NULL,
	"tx_sig" text,
	"agent_id" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"mint" text NOT NULL,
	"symbol" text DEFAULT '' NOT NULL,
	"token_amount" bigint NOT NULL,
	"cost_micro" bigint DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'idea' NOT NULL,
	"url" text,
	"description" text DEFAULT '' NOT NULL,
	"revenue_micro" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'spawn' NOT NULL,
	"path" text DEFAULT 'deposit' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_polled_at" timestamp with time zone,
	"deposit_pubkey" text NOT NULL,
	"deposit_secret_enc" "bytea",
	"deposit_iv" "bytea",
	"deposit_tag" "bytea",
	"claim_code_hash" text,
	"owner_wallet" text,
	"owner_id" text,
	"quoted_micro" bigint NOT NULL,
	"amount_micro" bigint DEFAULT 0 NOT NULL,
	"usdc_micro" bigint DEFAULT 0 NOT NULL,
	"eth_gwei" bigint DEFAULT 0 NOT NULL,
	"eth_value_micro" bigint DEFAULT 0 NOT NULL,
	"eth_price_usd" numeric(14, 4) DEFAULT 0 NOT NULL,
	"fee_bps" integer NOT NULL,
	"fee_micro" bigint DEFAULT 0 NOT NULL,
	"funding_micro" bigint DEFAULT 0 NOT NULL,
	"quoted_tier" text NOT NULL,
	"tier" text,
	"pace" text DEFAULT 'steady' NOT NULL,
	"heartbeat_min" integer,
	"model" text,
	"effort" text,
	"agent_name" text,
	"directive" text,
	"tools" jsonb,
	"fork_of" text,
	"topup_agent_id" text,
	"agent_id" text,
	"sweep_sig" text,
	"funding_sig" text,
	"refund_to" text,
	"refund_sig" text,
	"spawn_error" text,
	"spawn_attempts" integer DEFAULT 0 NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"buyer_type" text NOT NULL,
	"buyer_id" text NOT NULL,
	"price_micro" bigint NOT NULL,
	"status" text NOT NULL,
	"request" jsonb,
	"response" jsonb,
	"cpu_ms" integer DEFAULT 0 NOT NULL,
	"payment_tx" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price_micro" bigint NOT NULL,
	"handler_path" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"revenue_micro" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"n" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro" bigint DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"rounds" integer DEFAULT 0 NOT NULL,
	"stop_reason" text,
	"status" text DEFAULT 'running' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"error" text,
	"transcript" jsonb
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"mint" text NOT NULL,
	"symbol" text DEFAULT '' NOT NULL,
	"usdc_micro" bigint DEFAULT 0 NOT NULL,
	"token_amount" bigint NOT NULL,
	"realized_pnl_micro" bigint DEFAULT 0 NOT NULL,
	"tx_sig" text
);
--> statement-breakpoint
CREATE TABLE "user_keys" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"pubkey" text NOT NULL,
	"secret_enc" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"wallet" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone DEFAULT now() NOT NULL,
	"display_name" text,
	"kind" text DEFAULT 'wallet' NOT NULL,
	"payout_wallet" text,
	"purchase_id" text,
	"custodial_pubkey" text
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"owner_wallet" text NOT NULL,
	"amount_micro" bigint NOT NULL,
	"fee_micro" bigint NOT NULL,
	"tx_sig" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_wallet_users_wallet_fk" FOREIGN KEY ("owner_wallet") REFERENCES "public"."users"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_forked_from_agents_id_fk" FOREIGN KEY ("forked_from") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_claimer_agent_id_agents_id_fk" FOREIGN KEY ("claimer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits_seen" ADD CONSTRAINT "deposits_seen_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forks" ADD CONSTRAINT "forks_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forks" ADD CONSTRAINT "forks_child_agent_id_agents_id_fk" FOREIGN KEY ("child_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_messages" ADD CONSTRAINT "owner_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_txs" ADD CONSTRAINT "pool_txs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_fork_of_agents_id_fk" FOREIGN KEY ("fork_of") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_topup_agent_id_agents_id_fk" FOREIGN KEY ("topup_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_calls" ADD CONSTRAINT "service_calls_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_wallet_users_wallet_fk" FOREIGN KEY ("wallet") REFERENCES "public"."users"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_keys" ADD CONSTRAINT "user_keys_owner_id_users_wallet_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("wallet") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_name_uq" ON "agents" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_wallet_pubkey_uq" ON "agents" USING btree ("wallet_pubkey");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_deploy_slug_uq" ON "agents" USING btree ("deploy_slug");--> statement-breakpoint
CREATE INDEX "agents_owner_idx" ON "agents" USING btree ("owner_wallet");--> statement-breakpoint
CREATE INDEX "agents_purchase_idx" ON "agents" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "agents_status_next_step_idx" ON "agents" USING btree ("status","next_step_at");--> statement-breakpoint
CREATE INDEX "agents_forked_from_idx" ON "agents" USING btree ("forked_from");--> statement-breakpoint
CREATE INDEX "bounties_status_idx" ON "bounties" USING btree ("status","deadline_at");--> statement-breakpoint
CREATE INDEX "bounties_poster_idx" ON "bounties" USING btree ("poster_id");--> statement-breakpoint
CREATE INDEX "bounties_claimer_idx" ON "bounties" USING btree ("claimer_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bounties_escrow_tx_uq" ON "bounties" USING btree ("escrow_tx");--> statement-breakpoint
CREATE INDEX "decisions_agent_idx" ON "decisions" USING btree ("agent_id","id");--> statement-breakpoint
CREATE INDEX "deployments_agent_idx" ON "deployments" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "deployments_slug_idx" ON "deployments" USING btree ("slug","active");--> statement-breakpoint
CREATE INDEX "deposits_seen_agent_idx" ON "deposits_seen" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "events_ts_idx" ON "events" USING btree ("ts","id");--> statement-breakpoint
CREATE INDEX "events_agent_idx" ON "events" USING btree ("agent_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "forks_child_uq" ON "forks" USING btree ("child_agent_id");--> statement-breakpoint
CREATE INDEX "forks_parent_idx" ON "forks" USING btree ("parent_agent_id");--> statement-breakpoint
CREATE INDEX "ledger_agent_idx" ON "ledger" USING btree ("agent_id","id");--> statement-breakpoint
CREATE INDEX "ledger_ts_idx" ON "ledger" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "ledger_kind_idx" ON "ledger" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "owner_messages_agent_idx" ON "owner_messages" USING btree ("agent_id","id");--> statement-breakpoint
CREATE INDEX "pool_txs_ts_idx" ON "pool_txs" USING btree ("ts","id");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_agent_mint_uq" ON "positions" USING btree ("agent_id","mint");--> statement-breakpoint
CREATE INDEX "projects_agent_idx" ON "projects" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_deposit_pubkey_uq" ON "purchases" USING btree ("deposit_pubkey");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_claim_code_uq" ON "purchases" USING btree ("claim_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_name_reserved_uq" ON "purchases" USING btree ("agent_name") WHERE status in ('pending','received');--> statement-breakpoint
CREATE INDEX "purchases_status_idx" ON "purchases" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "purchases_owner_idx" ON "purchases" USING btree ("owner_id","id");--> statement-breakpoint
CREATE INDEX "purchases_agent_idx" ON "purchases" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "service_calls_service_idx" ON "service_calls" USING btree ("service_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_calls_payment_tx_uq" ON "service_calls" USING btree ("payment_tx");--> statement-breakpoint
CREATE INDEX "services_agent_idx" ON "services" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "services_status_idx" ON "services" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_wallet_idx" ON "sessions" USING btree ("wallet");--> statement-breakpoint
CREATE UNIQUE INDEX "steps_agent_n_uq" ON "steps" USING btree ("agent_id","n");--> statement-breakpoint
CREATE INDEX "steps_started_idx" ON "steps" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "trades_agent_idx" ON "trades" USING btree ("agent_id","id");--> statement-breakpoint
CREATE INDEX "withdrawals_agent_idx" ON "withdrawals" USING btree ("agent_id");