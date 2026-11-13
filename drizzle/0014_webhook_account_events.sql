CREATE TABLE "channel_activity" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"profile" jsonb,
	"seen_post_ids" text[],
	"checked_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_activity_failure_count" CHECK (failure_count >= 0),
	CONSTRAINT "channel_activity_seen_size" CHECK (coalesce(cardinality(seen_post_ids), 0) <= 200)
);
--> statement-breakpoint
ALTER TABLE "webhooks" DROP CONSTRAINT "webhooks_event_types";--> statement-breakpoint
ALTER TABLE "channel_activity" ADD CONSTRAINT "channel_activity_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_activity_organization" ON "channel_activity" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_event_types" CHECK (cardinality(event_types) > 0 and event_types <@ array['post.published', 'post.failed', 'post.metrics.changed', 'channel.metrics.changed', 'comment.created', 'channel.post.created', 'channel.profile.changed', 'channel.status.changed', 'reply.sent', 'reply.failed']::text[]);--> statement-breakpoint
-- Same role resolution as 0001_runtime_grants.sql.
DO $$
DECLARE
  runtime_role text;
  backup_role text;
BEGIN
  CASE current_database()
    WHEN 'leonessa_social_engine' THEN runtime_role := 'social_engine_runtime'; backup_role := NULL;
    WHEN 'leonessa_social_engine_staging' THEN runtime_role := 'social_engine_runtime_staging'; backup_role := 'social_engine_backup_staging';
    WHEN 'leonessa_social_engine_production' THEN runtime_role := 'social_engine_runtime_production'; backup_role := 'social_engine_backup_production';
    ELSE RAISE EXCEPTION 'unexpected database %', current_database();
  END CASE;
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.channel_activity TO %I', runtime_role);
  IF backup_role IS NOT NULL AND EXISTS (SELECT FROM pg_roles WHERE rolname = backup_role) THEN
    EXECUTE format('GRANT SELECT ON public.channel_activity TO %I', backup_role);
  END IF;
END
$$;
