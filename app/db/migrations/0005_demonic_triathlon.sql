ALTER TABLE "users" ADD COLUMN "email_canonical_hmac" varchar(64);--> statement-breakpoint
CREATE INDEX "users_email_canonical_idx" ON "users" USING btree ("email_canonical_hmac");