ALTER TABLE "browser_accounts" DROP CONSTRAINT "browser_accounts_platform";--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_platform";--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_kind";--> statement-breakpoint
ALTER TABLE "provider_apps" DROP CONSTRAINT "provider_apps_platform";--> statement-breakpoint
ALTER TABLE "browser_accounts" ADD CONSTRAINT "browser_accounts_platform" CHECK (platform in ('tiktok', 'x', 'linkedin', 'threads', 'pinterest', 'reddit'));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_platform" CHECK (platform in ('meta', 'tiktok', 'youtube', 'instagram', 'x', 'linkedin', 'threads', 'pinterest', 'reddit'));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_kind" CHECK (kind in ('facebook_page', 'instagram_account', 'tiktok_account', 'youtube_channel', 'x_account', 'linkedin_profile', 'linkedin_page', 'threads_account', 'pinterest_account', 'reddit_account'));--> statement-breakpoint
ALTER TABLE "provider_apps" ADD CONSTRAINT "provider_apps_platform" CHECK (platform in ('meta', 'tiktok', 'youtube', 'instagram', 'x', 'linkedin', 'threads', 'pinterest', 'reddit'));