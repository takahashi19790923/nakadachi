CREATE TABLE "site_flags" (
	"id" varchar(16) PRIMARY KEY NOT NULL,
	"signups_paused" boolean DEFAULT false NOT NULL,
	"listings_paused" boolean DEFAULT false NOT NULL,
	"messages_paused" boolean DEFAULT false NOT NULL,
	"notice" varchar(300),
	"updated_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
