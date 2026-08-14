CREATE TYPE "public"."admin_action_type" AS ENUM('listing_suspend', 'listing_reject', 'listing_restore', 'listing_delete', 'user_suspend', 'user_restore', 'payment_refund', 'report_resolve', 'thread_view', 'banned_word_add', 'banned_word_remove');--> statement-breakpoint
CREATE TYPE "public"."banned_word_severity" AS ENUM('block', 'flag');--> statement-breakpoint
CREATE TYPE "public"."deletion_request_status" AS ENUM('pending', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."email_delivery_status" AS ENUM('queued', 'sent', 'failed', 'bounced', 'complained', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."handover_method" AS ENUM('pickup', 'shipping', 'either');--> statement-breakpoint
CREATE TYPE "public"."item_condition" AS ENUM('new', 'like_new', 'good', 'fair', 'poor', 'for_parts');--> statement-breakpoint
CREATE TYPE "public"."listing_kind" AS ENUM('sell', 'buy', 'give', 'realestate', 'tool', 'appliance', 'outdoor', 'vehicle', 'other', 'online', 'inperson', 'both', 'part_time', 'full_time');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('draft', 'payment_pending', 'payment_processing', 'published', 'closed', 'rejected', 'suspended', 'expired', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."location_kind" AS ENUM('prefecture', 'city');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('created', 'pending', 'succeeded', 'failed', 'expired', 'refunded', 'partially_refunded', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."price_type" AS ENUM('fixed', 'negotiable', 'free');--> statement-breakpoint
CREATE TYPE "public"."price_unit" AS ENUM('once', 'hour', 'day', 'week', 'month', 'year', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_reason" AS ENUM('prohibited_item', 'spam', 'fraud', 'harassment', 'personal_info', 'illegal_job', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'reviewing', 'actioned', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."report_target_type" AS ENUM('listing', 'message', 'user');--> statement-breakpoint
CREATE TYPE "public"."thread_participant_role" AS ENUM('owner', 'inquirer');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."verification_purpose" AS ENUM('login', 'email_change', 'account_deletion', 'admin_reauth');--> statement-breakpoint
CREATE TYPE "public"."webhook_event_status" AS ENUM('received', 'processed', 'ignored', 'failed');--> statement-breakpoint
CREATE TABLE "favorites" (
	"user_id" varchar(26) NOT NULL,
	"listing_id" varchar(26) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_category_details" (
	"listing_id" varchar(26) PRIMARY KEY NOT NULL,
	"item_condition" "item_condition",
	"handover_method" "handover_method",
	"deposit_required" boolean,
	"deposit_note" varchar(200),
	"available_from" date,
	"available_to" date,
	"rental_terms" varchar(500),
	"service_content" varchar(500),
	"availability_note" varchar(200),
	"salary_max_jpy" integer,
	"work_location_note" varchar(120),
	"work_hours" varchar(200),
	"qualifications" varchar(500),
	"benefits" varchar(500),
	"company_name" varchar(80),
	"extra" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_images" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"listing_id" varchar(26) NOT NULL,
	"object_key" varchar(160) NOT NULL,
	"content_type" varchar(40) NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"checksum_sha256" varchar(64) NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"purge_after" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"owner_id" varchar(26) NOT NULL,
	"category_id" varchar(26) NOT NULL,
	"kind" "listing_kind" NOT NULL,
	"title" varchar(80) NOT NULL,
	"body" text NOT NULL,
	"status" "listing_status" DEFAULT 'draft' NOT NULL,
	"price_jpy" integer,
	"price_type" "price_type" DEFAULT 'fixed' NOT NULL,
	"price_unit" "price_unit" DEFAULT 'once' NOT NULL,
	"prefecture_code" varchar(8) NOT NULL,
	"city_code" varchar(8) NOT NULL,
	"area_note" varchar(60),
	"published_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"moderation_reason" text,
	"view_count" integer DEFAULT 0 NOT NULL,
	"search_text" text GENERATED ALWAYS AS ((coalesce(title,'') || ' ' || coalesce(body,'') || ' ' || coalesce(area_note,''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"blocker_id" varchar(26) NOT NULL,
	"blocked_id" varchar(26) NOT NULL,
	"reason" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"thread_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"role" "thread_participant_role" NOT NULL,
	"last_read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_participants_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_threads" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"listing_id" varchar(26) NOT NULL,
	"initiator_id" varchar(26) NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"thread_id" varchar(26) NOT NULL,
	"sender_id" varchar(26) NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" varchar(26)
);
--> statement-breakpoint
CREATE TABLE "banned_words" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"word" varchar(60) NOT NULL,
	"severity" "banned_word_severity" DEFAULT 'flag' NOT NULL,
	"note" varchar(200),
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"reporter_id" varchar(26) NOT NULL,
	"target_type" "report_target_type" NOT NULL,
	"target_listing_id" varchar(26),
	"target_message_id" varchar(26),
	"target_user_id" varchar(26),
	"reason" "report_reason" NOT NULL,
	"detail" varchar(1000),
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" varchar(26),
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_exactly_one_target" CHECK ((
        (case when "reports"."target_listing_id" is null then 0 else 1 end)
      + (case when "reports"."target_message_id" is null then 0 else 1 end)
      + (case when "reports"."target_user_id" is null then 0 else 1 end)
      ) = 1)
);
--> statement-breakpoint
CREATE TABLE "admin_actions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"admin_id" varchar(26) NOT NULL,
	"action_type" "admin_action_type" NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" varchar(40) NOT NULL,
	"reason" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"actor_id" varchar(40),
	"actor_role" varchar(20),
	"action" varchar(60) NOT NULL,
	"target_type" varchar(32),
	"target_id" varchar(40),
	"ip_hash" varchar(64),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_delivery_logs" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"template" varchar(60) NOT NULL,
	"recipient_hmac" varchar(64) NOT NULL,
	"user_id" varchar(26),
	"listing_id" varchar(26),
	"idempotency_key" varchar(120) NOT NULL,
	"provider_message_id" varchar(120),
	"status" "email_delivery_status" DEFAULT 'queued' NOT NULL,
	"error_code" varchar(80),
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_webhook_events" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"provider" varchar(20) DEFAULT 'stripe' NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"payload_digest" varchar(64) NOT NULL,
	"status" "webhook_event_status" DEFAULT 'received' NOT NULL,
	"listing_id" varchar(26),
	"payment_id" varchar(26),
	"error_message" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"listing_id" varchar(26),
	"user_id" varchar(26),
	"provider" varchar(20) DEFAULT 'stripe' NOT NULL,
	"checkout_session_id" varchar(255) NOT NULL,
	"payment_intent_id" varchar(255),
	"charge_id" varchar(255),
	"amount_jpy" integer NOT NULL,
	"currency" varchar(8) NOT NULL,
	"status" "payment_status" DEFAULT 'created' NOT NULL,
	"paid_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"refunded_amount_jpy" integer DEFAULT 0 NOT NULL,
	"failure_code" varchar(60),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"slug" varchar(32) NOT NULL,
	"name" varchar(60) NOT NULL,
	"description" varchar(200),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"code" varchar(8) NOT NULL,
	"kind" "location_kind" NOT NULL,
	"parent_code" varchar(8),
	"name" varchar(40) NOT NULL,
	"kana" varchar(60),
	"romaji" varchar(40),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_code_key" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "account_deletion_requests" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"status" "deletion_request_status" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_purge_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_verification_tokens" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"user_id" varchar(26),
	"email_hmac" varchar(64) NOT NULL,
	"purpose" "verification_purpose" NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"otp_hash" varchar(64) NOT NULL,
	"new_email_encrypted" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"requested_ip_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"ip_hash" varchar(64),
	"user_agent" varchar(200),
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" varchar(26) PRIMARY KEY NOT NULL,
	"display_name" varchar(40) NOT NULL,
	"bio" varchar(400),
	"prefecture_code" varchar(8),
	"city_code" varchar(8),
	"notify_on_message" boolean DEFAULT true NOT NULL,
	"notify_on_expiry" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"email_encrypted" text NOT NULL,
	"email_hmac" varchar(64) NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"suspended_reason" text,
	"suspended_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_category_details" ADD CONSTRAINT "listing_category_details_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_images" ADD CONSTRAINT "listing_images_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_prefecture_code_locations_code_fk" FOREIGN KEY ("prefecture_code") REFERENCES "public"."locations"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_city_code_locations_code_fk" FOREIGN KEY ("city_code") REFERENCES "public"."locations"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_initiator_id_users_id_fk" FOREIGN KEY ("initiator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_listing_id_listings_id_fk" FOREIGN KEY ("target_listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_message_id_messages_id_fk" FOREIGN KEY ("target_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_prefecture_code_locations_code_fk" FOREIGN KEY ("prefecture_code") REFERENCES "public"."locations"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_city_code_locations_code_fk" FOREIGN KEY ("city_code") REFERENCES "public"."locations"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "favorites_user_listing_key" ON "favorites" USING btree ("user_id","listing_id");--> statement-breakpoint
CREATE INDEX "favorites_user_created_idx" ON "favorites" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "favorites_listing_idx" ON "favorites" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "lcd_item_condition_idx" ON "listing_category_details" USING btree ("item_condition");--> statement-breakpoint
CREATE INDEX "lcd_available_idx" ON "listing_category_details" USING btree ("available_from","available_to");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_images_object_key_key" ON "listing_images" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "listing_images_listing_position_idx" ON "listing_images" USING btree ("listing_id","position");--> statement-breakpoint
CREATE INDEX "listing_images_purge_idx" ON "listing_images" USING btree ("purge_after");--> statement-breakpoint
CREATE INDEX "listings_status_published_at_idx" ON "listings" USING btree ("status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "listings_status_pref_published_idx" ON "listings" USING btree ("status","prefecture_code","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "listings_status_city_published_idx" ON "listings" USING btree ("status","city_code","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "listings_status_category_published_idx" ON "listings" USING btree ("status","category_id","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "listings_status_kind_idx" ON "listings" USING btree ("status","kind");--> statement-breakpoint
CREATE INDEX "listings_status_price_idx" ON "listings" USING btree ("status","price_jpy");--> statement-breakpoint
CREATE INDEX "listings_owner_status_idx" ON "listings" USING btree ("owner_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "listings_expiring_idx" ON "listings" USING btree ("expires_at") WHERE status = 'published';--> statement-breakpoint
CREATE INDEX "listings_search_text_trgm_idx" ON "listings" USING gin ("search_text" gin_trgm_ops) WHERE status = 'published';--> statement-breakpoint
CREATE INDEX "blocks_blocked_idx" ON "blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE INDEX "participants_user_idx" ON "conversation_participants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_listing_initiator_key" ON "conversation_threads" USING btree ("listing_id","initiator_id");--> statement-breakpoint
CREATE INDEX "threads_listing_idx" ON "conversation_threads" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "threads_last_message_idx" ON "conversation_threads" USING btree ("last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_thread_created_idx" ON "messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_sender_idx" ON "messages" USING btree ("sender_id");--> statement-breakpoint
CREATE UNIQUE INDEX "banned_words_word_key" ON "banned_words" USING btree ("word");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_reporter_listing_key" ON "reports" USING btree ("reporter_id","target_listing_id") WHERE target_listing_id is not null;--> statement-breakpoint
CREATE INDEX "reports_status_created_idx" ON "reports" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reports_target_listing_idx" ON "reports" USING btree ("target_listing_id");--> statement-breakpoint
CREATE INDEX "reports_target_user_idx" ON "reports" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "admin_actions_admin_created_idx" ON "admin_actions" USING btree ("admin_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_actions_target_idx" ON "admin_actions" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "admin_actions_type_idx" ON "admin_actions" USING btree ("action_type");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "edl_idempotency_key" ON "email_delivery_logs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "edl_recipient_idx" ON "email_delivery_logs" USING btree ("recipient_hmac");--> statement-breakpoint
CREATE INDEX "edl_status_idx" ON "email_delivery_logs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "edl_created_idx" ON "email_delivery_logs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rate_limits_expires_idx" ON "rate_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pwe_provider_event_id_key" ON "payment_webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "pwe_status_idx" ON "payment_webhook_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pwe_received_at_idx" ON "payment_webhook_events" USING btree ("received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "payments_checkout_session_id_key" ON "payments" USING btree ("checkout_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_payment_intent_id_key" ON "payments" USING btree ("payment_intent_id");--> statement-breakpoint
CREATE INDEX "payments_listing_idx" ON "payments" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "payments_user_created_idx" ON "payments" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payments_charge_id_idx" ON "payments" USING btree ("charge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_key" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_sort_order_idx" ON "categories" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "locations_kind_parent_idx" ON "locations" USING btree ("kind","parent_code","sort_order");--> statement-breakpoint
CREATE INDEX "locations_romaji_idx" ON "locations" USING btree ("romaji");--> statement-breakpoint
CREATE UNIQUE INDEX "adr_user_pending_key" ON "account_deletion_requests" USING btree ("user_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "adr_scheduled_purge_at_idx" ON "account_deletion_requests" USING btree ("scheduled_purge_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evt_token_hash_key" ON "email_verification_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "evt_email_hmac_purpose_idx" ON "email_verification_tokens" USING btree ("email_hmac","purpose");--> statement-breakpoint
CREATE INDEX "evt_expires_at_idx" ON "email_verification_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_profiles_prefecture_idx" ON "user_profiles" USING btree ("prefecture_code");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_hmac_key" ON "users" USING btree ("email_hmac");--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");