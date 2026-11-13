CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"error_code" text,
	"detail" text,
	CONSTRAINT "attempts_outcome" CHECK (outcome is null or outcome in ('succeeded', 'failed_retryable', 'failed_final', 'uncertain'))
);
--> statement-breakpoint
CREATE TABLE "channel_credentials" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"expires_at" timestamp with time zone,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider_app_id" text NOT NULL,
	"platform" text NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_app_external_organization" UNIQUE("provider_app_id","external_id","organization_id"),
	CONSTRAINT "channels_platform" CHECK (platform in ('meta')),
	CONSTRAINT "channels_kind" CHECK (kind in ('facebook_page', 'instagram_account')),
	CONSTRAINT "channels_status" CHECK (status in ('active', 'needs_reauth', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"job_id" uuid,
	"channel_id" uuid,
	"kind" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"post_id" text NOT NULL,
	"revision" integer NOT NULL,
	"channel_id" uuid NOT NULL,
	"action" text DEFAULT 'publish' NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"publish_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"receipt" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_post_revision_channel" UNIQUE("organization_id","post_id","revision","channel_id"),
	CONSTRAINT "jobs_state" CHECK (state in ('queued', 'running', 'published', 'failed', 'uncertain', 'cancelled')),
	CONSTRAINT "jobs_action" CHECK (action in ('publish')),
	CONSTRAINT "jobs_revision" CHECK (revision > 0),
	CONSTRAINT "jobs_payload_size" CHECK (pg_column_size(payload) <= 262144)
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_mime_type" CHECK (mime_type in ('image/jpeg', 'image/png'))
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider_app_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"external_app_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_organization_id" text,
	"secret_ref" text NOT NULL,
	"mode" text DEFAULT 'development' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_apps_platform_external" UNIQUE("platform","external_app_id"),
	CONSTRAINT "provider_apps_platform" CHECK (platform in ('meta')),
	CONSTRAINT "provider_apps_owner_kind" CHECK (owner_kind in ('agency', 'tenant')),
	CONSTRAINT "provider_apps_mode" CHECK (mode in ('development', 'live')),
	CONSTRAINT "provider_apps_tenant_owner" CHECK ((owner_kind = 'tenant') = (owner_organization_id is not null))
);
--> statement-breakpoint
CREATE TABLE "publishing_controls" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"paused_channel_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_credentials" ADD CONSTRAINT "channel_credentials_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_provider_app_id_provider_apps_id_fk" FOREIGN KEY ("provider_app_id") REFERENCES "public"."provider_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_provider_app_id_provider_apps_id_fk" FOREIGN KEY ("provider_app_id") REFERENCES "public"."provider_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempts_job" ON "attempts" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "attempts_open" ON "attempts" USING btree ("started_at") WHERE finished_at is null;--> statement-breakpoint
CREATE INDEX "channels_organization" ON "channels" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "events_organization" ON "events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_due" ON "jobs" USING btree ("not_before") WHERE state = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_post" ON "jobs" USING btree ("organization_id","post_id");--> statement-breakpoint
CREATE INDEX "media_organization" ON "media" USING btree ("organization_id");