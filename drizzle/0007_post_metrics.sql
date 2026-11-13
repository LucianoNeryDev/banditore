CREATE TABLE "post_metrics" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unavailable" text[] DEFAULT '{}'::text[] NOT NULL,
	"collected_at" timestamp with time zone,
	"next_collect_at" timestamp with time zone NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_metrics_failure_count" CHECK (failure_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_metrics_due" ON "post_metrics" USING btree ("next_collect_at");--> statement-breakpoint
CREATE INDEX "post_metrics_organization" ON "post_metrics" USING btree ("organization_id");--> statement-breakpoint
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
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.post_metrics TO %I', runtime_role);
  IF backup_role IS NOT NULL AND EXISTS (SELECT FROM pg_roles WHERE rolname = backup_role) THEN
    EXECUTE format('GRANT SELECT ON public.post_metrics TO %I', backup_role);
  END IF;
END
$$;
