import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import { timestamps, ulidPk, ulidRef } from "./_shared.ts";
import { adminActionTypeEnum, emailDeliveryStatusEnum } from "./enums.ts";
import { users } from "./users.ts";

/**
 * 管理操作の記録。
 *
 * 「誰が・いつ・何に・なぜ」を必ず残す。理由（reason）を必須にしているのは、
 * あとから見て判断の当否を検証できるようにするため。
 */
export const adminActions = pgTable(
  "admin_actions",
  {
    id: ulidPk(),
    /*
     * 管理者が退会したら null にする。
     *
     * 以前は restrict だったが、それだと管理操作を1件でも行った利用者の
     * 退会削除が毎日失敗し続け、「30日後に消します」が永久に果たされない
     * （2026-08-17 の点検で発覚。erasure-service は restrict の表を先に
     * 片づける前提で書かれていたが、片づけていなかった）。
     * 「誰が」は audit_logs（外部キー無し・消さない）に残る。
     */
    adminId: ulidRef("admin_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actionType: adminActionTypeEnum("action_type").notNull(),
    targetType: varchar("target_type", { length: 32 }).notNull(),
    targetId: varchar("target_id", { length: 40 }).notNull(),
    reason: text("reason").notNull(),
    /** 個人情報を入れないこと。件数や状態など、判断の根拠になる値だけ */
    metadata: jsonb("metadata").$type<Record<string, string | number>>(),
    ...timestamps(),
  },
  (t) => [
    index("admin_actions_admin_created_idx").on(t.adminId, t.createdAt.desc()),
    index("admin_actions_target_idx").on(t.targetType, t.targetId),
    index("admin_actions_type_idx").on(t.actionType),
  ],
);

/**
 * 監査ログ。
 *
 * ★users への外部キーを張っていない。★ 張ると、退会で利用者を消したときに
 * 「消したという記録」まで一緒に消える。ここには ULID を文字列として置き、
 * 参照整合性より記録の残存を優先する。
 *
 * ★個人情報を書かないこと。★ メールアドレス・氏名・IP をそのまま入れると、
 * 「消したのにログに残っている」という状態になり、削除した意味がなくなる。
 * 必要なら ipHash のようなハッシュだけを持つ。
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: ulidPk(),
    actorId: varchar("actor_id", { length: 40 }),
    actorRole: varchar("actor_role", { length: 20 }),
    action: varchar("action", { length: 60 }).notNull(),
    targetType: varchar("target_type", { length: 32 }),
    targetId: varchar("target_id", { length: 40 }),
    ipHash: varchar("ip_hash", { length: 64 }),
    metadata: jsonb("metadata").$type<Record<string, string | number>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_logs_created_idx").on(t.createdAt.desc()),
    index("audit_logs_actor_idx").on(t.actorId),
    index("audit_logs_action_idx").on(t.action),
    index("audit_logs_target_idx").on(t.targetType, t.targetId),
  ],
);

/**
 * メール配信の記録。
 *
 * ★宛先を平文で持たない。★ users と同じ鍵で作った HMAC だけを置く。
 * これがあると、退会時に「その人宛のログ」を user_id 抜きでも特定できる。
 *
 * idempotencyKey に一意制約があるので、同じ出来事で二重に送らない。
 * 送信に失敗しても、この行が残るので再送できる。
 */
export const emailDeliveryLogs = pgTable(
  "email_delivery_logs",
  {
    id: ulidPk(),
    template: varchar("template", { length: 60 }).notNull(),
    recipientHmac: varchar("recipient_hmac", { length: 64 }).notNull(),
    userId: ulidRef("user_id"),
    listingId: ulidRef("listing_id"),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    providerMessageId: varchar("provider_message_id", { length: 120 }),
    status: emailDeliveryStatusEnum("status").notNull().default("queued"),
    /** 事業者から返った短いエラー種別。本文全体は残さない */
    errorCode: varchar("error_code", { length: 80 }),
    attemptCount: integer("attempt_count").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("edl_idempotency_key").on(t.idempotencyKey),
    index("edl_recipient_idx").on(t.recipientHmac),
    index("edl_status_idx").on(t.status),
    index("edl_created_idx").on(t.createdAt.desc()),
  ],
);

/**
 * レート制限のカウンタ。
 *
 * Cloudflare の Rate limiting rules は Free プランだとゾーン全体で1つしか
 * 持てず、同じゾーンの全サービスで1枠を取り合う。エッジ側は当てにせず、
 * ★アプリ側で必ず持つ★。
 *
 * key は「用途 + 主体」を SHA-256 にしたもの。IP やメールアドレスを
 * そのまま鍵にすると、この表自体が個人情報の一覧になる。
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: varchar("key", { length: 64 }).primaryKey(),
    count: integer("count").notNull().default(0),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("rate_limits_expires_idx").on(t.expiresAt)],
);

/**
 * 運用の切り替えスイッチ。
 *
 * ★事故のときに «止める» 手段が、これまで再デプロイしかなかった。★
 * 「掲載の受付だけ止めたい」「登録だけ止めたい」ができず、
 * 手順書にも「Workers のルートを外す」としか書いていなかった
 * （全部止まる。復旧の練習中にも使えない）。
 *
 * ★1行しか持たない。★ id は固定値。行が無ければ「全部動いている」と
 * みなす（fail-open）。ここを fail-close にすると、この表を作り忘れた
 * 環境や、移行の途中でサイトが真っ白になる。
 *
 * ★DB が落ちているときには使えない。★ その場合の «全部止める» は
 * Cloudflare 側（ルートを外す／エッジのルール）で行う。
 * ここが担当するのは「サイトは動いているが、ある機能だけ止めたい」。
 */
export const siteFlags = pgTable("site_flags", {
  /** 常に 'singleton'。行を1つに保つための固定値 */
  id: varchar("id", { length: 16 }).primaryKey(),
  /** 新規登録を止める（既存の利用者はログインできる） */
  signupsPaused: boolean("signups_paused").notNull().default(false),
  /** 新しい掲載の作成と決済を止める（公開中のものはそのまま） */
  listingsPaused: boolean("listings_paused").notNull().default(false),
  /** メッセージの送信を止める */
  messagesPaused: boolean("messages_paused").notNull().default(false),
  /** 画面に出す案内。空なら既定の文言 */
  notice: varchar("notice", { length: 300 }),
  /** 最後に触った管理者。誰が止めたかを追えるように */
  updatedBy: ulidRef("updated_by"),
  ...timestamps(),
});
