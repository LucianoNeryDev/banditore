CREATE TABLE "media_chunks" (
	"media_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "media_chunks_media_id_position_pk" PRIMARY KEY("media_id","position")
);
--> statement-breakpoint
ALTER TABLE "media" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_chunks" ADD CONSTRAINT "media_chunks_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Video does not compress; skip the attempt.
ALTER TABLE "media_chunks" ALTER COLUMN "data" SET STORAGE EXTERNAL;--> statement-breakpoint
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
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_chunks TO %I', runtime_role);
  IF backup_role IS NOT NULL AND EXISTS (SELECT FROM pg_roles WHERE rolname = backup_role) THEN
    EXECUTE format('GRANT SELECT ON public.media_chunks TO %I', backup_role);
  END IF;
END
$$;
