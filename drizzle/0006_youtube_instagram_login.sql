ALTER TABLE "channels" DROP CONSTRAINT "channels_platform";--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_kind";--> statement-breakpoint
ALTER TABLE "provider_apps" DROP CONSTRAINT "provider_apps_platform";--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_platform" CHECK (platform in ('meta', 'tiktok', 'youtube', 'instagram'));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_kind" CHECK (kind in ('facebook_page', 'instagram_account', 'tiktok_account', 'youtube_channel'));--> statement-breakpoint
ALTER TABLE "provider_apps" ADD CONSTRAINT "provider_apps_platform" CHECK (platform in ('meta', 'tiktok', 'youtube', 'instagram'));