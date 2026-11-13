CREATE TABLE "browser_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"status" text DEFAULT 'needs_login' NOT NULL,
	"ephemeral_public_key" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_accounts_organization_platform_handle" UNIQUE("organization_id","platform","handle"),
	CONSTRAINT "browser_accounts_platform" CHECK (platform in ('tiktok')),
	CONSTRAINT "browser_accounts_status" CHECK (status in ('active', 'needs_login', 'disabled')),
	CONSTRAINT "browser_accounts_ciphertext_size" CHECK (octet_length(ciphertext) <= 8192)
);
--> statement-breakpoint
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
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.browser_accounts TO %I', runtime_role);
  IF backup_role IS NOT NULL AND EXISTS (SELECT FROM pg_roles WHERE rolname = backup_role) THEN
    EXECUTE format('GRANT SELECT ON public.browser_accounts TO %I', backup_role);
  END IF;
END
$$;
