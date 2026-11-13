CREATE INDEX "jobs_organization_publish" ON "jobs" USING btree ("organization_id","publish_at","id");--> statement-breakpoint
CREATE INDEX "post_metric_samples_channel" ON "post_metric_samples" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "response_checks_channel" ON "response_checks" USING btree ("channel_id");