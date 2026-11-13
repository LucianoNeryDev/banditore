ALTER TABLE "channels" DROP CONSTRAINT "channels_platform";--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_kind";--> statement-breakpoint
ALTER TABLE "media" DROP CONSTRAINT "media_mime_type";--> statement-breakpoint
ALTER TABLE "provider_apps" DROP CONSTRAINT "provider_apps_platform";--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "provider_app_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "browser_account_id" uuid;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_browser_account_id_browser_accounts_id_fk" FOREIGN KEY ("browser_account_id") REFERENCES "public"."browser_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_browser_account" UNIQUE("browser_account_id");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_driver" CHECK ((provider_app_id is null) <> (browser_account_id is null));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_platform" CHECK (platform in ('meta', 'tiktok'));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_kind" CHECK (kind in ('facebook_page', 'instagram_account', 'tiktok_account'));--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_mime_type" CHECK (mime_type in ('image/jpeg', 'image/png', 'video/mp4'));--> statement-breakpoint
ALTER TABLE "provider_apps" ADD CONSTRAINT "provider_apps_platform" CHECK (platform in ('meta', 'tiktok'));