import { relations } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import { timestamps, ulidPk, ulidRef } from "./_shared.ts";
import { paymentStatusEnum, webhookEventStatusEnum } from "./enums.ts";
import { listings } from "./listings.ts";
import { users } from "./users.ts";

/**
 * 決済記録。
 *
 * ★金額は円単位の整数。★ 浮動小数点で持たない。
 * ★checkoutSessionId に一意制約を置く。★ 同じ投稿に対して二重に課金しない
 * ための最後の砦になる。アプリ側の重複チェックが競合で抜けても、ここで落ちる。
 */
export const payments = pgTable(
  "payments",
  {
    id: ulidPk(),
    /**
     * ★どちらも NULL 可・ON DELETE SET NULL。★
     *
     * 決済の記録は法令上の保存義務があるため、退会しても消せない。
     * 一方で「消したのに個人が特定できる」状態も作れない。
     * 参照だけを外して、金額・日時・決済事業者側の識別子を残す形にする。
     * NOT NULL のままだと、退会処理が外部キーで必ず失敗する
     * （そして try/catch に握られて誰も気づかない、という壊れ方をする）。
     */
    listingId: ulidRef("listing_id").references(() => listings.id, {
      onDelete: "set null",
    }),
    userId: ulidRef("user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    /** 将来 Stripe 以外へ替えられるよう、提供者名を持たせておく */
    provider: varchar("provider", { length: 20 }).notNull().default("stripe"),
    checkoutSessionId: varchar("checkout_session_id", { length: 255 }).notNull(),
    paymentIntentId: varchar("payment_intent_id", { length: 255 }),
    chargeId: varchar("charge_id", { length: 255 }),

    amountJpy: integer("amount_jpy").notNull(),
    currency: varchar("currency", { length: 8 }).notNull(),

    status: paymentStatusEnum("status").notNull().default("created"),

    paidAt: timestamp("paid_at", { withTimezone: true }),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    refundedAmountJpy: integer("refunded_amount_jpy").notNull().default(0),
    /** 利用者向けの短い理由。決済事業者の生メッセージをそのまま出さない */
    failureCode: varchar("failure_code", { length: 60 }),

    ...timestamps(),
  },
  (t) => [
    uniqueIndex("payments_checkout_session_id_key").on(t.checkoutSessionId),
    uniqueIndex("payments_payment_intent_id_key").on(t.paymentIntentId),
    index("payments_listing_idx").on(t.listingId),
    index("payments_user_created_idx").on(t.userId, t.createdAt.desc()),
    // 管理画面の全件一覧は created_at だけで並べる。(user_id, created_at) は使えない。
    index("payments_created_idx").on(t.createdAt.desc()),
    index("payments_status_idx").on(t.status),
    index("payments_charge_id_idx").on(t.chargeId),
  ],
);

/**
 * 決済事業者の Webhook イベント。
 *
 * ★eventId の一意制約が冪等性の根拠。★ Stripe は同じイベントを何度でも
 * 再送する（配信失敗時のリトライ、手動再送）。「処理済みかどうか」を
 * アプリのメモリや条件分岐で判断すると、同時に2通届いた場合に二重処理する。
 * INSERT が一意制約で落ちることをもって「すでに処理済み」と判定する。
 *
 * ★本文そのものを保存しない。★ 決済イベントには氏名・メールアドレス・
 * 住所が入りうる。突き合わせに必要なのはダイジェストだけ。
 */
export const paymentWebhookEvents = pgTable(
  "payment_webhook_events",
  {
    id: ulidPk(),
    provider: varchar("provider", { length: 20 }).notNull().default("stripe"),
    eventId: varchar("event_id", { length: 255 }).notNull(),
    eventType: varchar("event_type", { length: 80 }).notNull(),
    /** 受け取った生の本文の SHA-256。再送の同一性確認だけに使う */
    payloadDigest: varchar("payload_digest", { length: 64 }).notNull(),
    status: webhookEventStatusEnum("status").notNull().default("received"),
    /** 紐づいた投稿・決済（判明した場合のみ） */
    listingId: ulidRef("listing_id"),
    paymentId: ulidRef("payment_id"),
    errorMessage: text("error_message"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("pwe_provider_event_id_key").on(t.provider, t.eventId),
    index("pwe_status_idx").on(t.status),
    index("pwe_received_at_idx").on(t.receivedAt.desc()),
  ],
);

export const paymentsRelations = relations(payments, ({ one }) => ({
  listing: one(listings, {
    fields: [payments.listingId],
    references: [listings.id],
  }),
  user: one(users, { fields: [payments.userId], references: [users.id] }),
}));
