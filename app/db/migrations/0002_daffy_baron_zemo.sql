CREATE TABLE "access_records" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"user_id" varchar(26),
	"action" varchar(32) NOT NULL,
	"target_type" varchar(32),
	"target_id" varchar(40),
	"ip_encrypted" varchar(255) NOT NULL,
	"ip_hmac" varchar(64) NOT NULL,
	"user_agent" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "access_records_user_idx" ON "access_records" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "access_records_target_idx" ON "access_records" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "access_records_ip_idx" ON "access_records" USING btree ("ip_hmac","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "access_records_expires_idx" ON "access_records" USING btree ("expires_at");