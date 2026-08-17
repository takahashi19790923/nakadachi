import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import { softDelete, timestamps, ulidPk, ulidRef } from "./_shared.ts";
import {
  deletionRequestStatusEnum,
  userRoleEnum,
  userStatusEnum,
  verificationPurposeEnum,
} from "./enums.ts";
import { locations } from "./taxonomy.ts";

/**
 * 利用者。
 *
 * ★メールアドレスを平文で持たない。★
 * 本文は AES-GCM で暗号化して emailEncrypted に、検索用には別の鍵で作った
 * HMAC を emailHmac に入れる。DB が丸ごと漏れても、鍵が別に管理されている
 * 限りアドレス一覧にはならない。
 *
 * HMAC を一意キーにしているので「同じアドレスで二重登録」も防げる。
 * ただし ★退会時の削除は emailHmac で紐づく行も対象にすること★。
 * user_id だけで消すと、HMAC で結びつく行（メール配信ログ・確認トークン）が
 * 残り、「30日後に削除します」が嘘になる。
 */
export const users = pgTable(
  "users",
  {
    id: ulidPk(),
    emailEncrypted: text("email_encrypted").notNull(),
    emailHmac: varchar("email_hmac", { length: 64 }).notNull(),
    role: userRoleEnum("role").notNull().default("user"),
    status: userStatusEnum("status").notNull().default("active"),
    /** 停止の理由。利用者本人にはそのまま見せない（内部向け） */
    suspendedReason: text("suspended_reason"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex("users_email_hmac_key").on(t.emailHmac),
    index("users_role_idx").on(t.role),
    index("users_status_idx").on(t.status),
  ],
);

export const userProfiles = pgTable(
  "user_profiles",
  {
    userId: ulidRef("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: varchar("display_name", { length: 40 }).notNull(),
    bio: varchar("bio", { length: 400 }),
    /** 既定の活動エリア。投稿フォームの初期値に使うだけで、公開はしない */
    prefectureCode: varchar("prefecture_code", { length: 8 }).references(
      () => locations.code,
    ),
    cityCode: varchar("city_code", { length: 8 }).references(
      () => locations.code,
    ),
    notifyOnMessage: boolean("notify_on_message").notNull().default(true),
    notifyOnExpiry: boolean("notify_on_expiry").notNull().default(true),
    ...timestamps(),
  },
  (t) => [index("user_profiles_prefecture_idx").on(t.prefectureCode)],
);

/**
 * ログインセッション。
 *
 * Cookie に入れるのは 32 バイトの乱数そのもの。DB にはその SHA-256 だけを
 * 置く。DB が漏れてもセッションを乗っ取れないようにするため。
 * ログイン成功時には必ず新しい行を作り直す（セッション固定攻撃対策）。
 */
export const sessions = pgTable(
  "sessions",
  {
    id: ulidPk(),
    userId: ulidRef("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    /** 生の IP は保存しない。乱用の追跡に足りる粒度のハッシュだけを持つ */
    ipHash: varchar("ip_hash", { length: 64 }),
    userAgent: varchar("user_agent", { length: 200 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_key").on(t.tokenHash),
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

/**
 * メール確認トークン（ログインリンクと OTP）。
 *
 * ★平文で保存しない。期限を持つ。一度使ったら再利用できない。★
 * リンク用トークンと6桁 OTP の両方を1行に持ち、どちらか一方が使われた
 * 時点で consumedAt を立てて両方を無効にする。
 *
 * userId は nullable。まだ登録していないアドレスにも送るため
 * （「登録済みかどうか」を応答から推測させないための設計）。
 */
export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    id: ulidPk(),
    userId: ulidRef("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    emailHmac: varchar("email_hmac", { length: 64 }).notNull(),
    purpose: verificationPurposeEnum("purpose").notNull(),
    /** マジックリンクに載せる乱数の SHA-256 */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    /** 6桁 OTP の SHA-256。総当たりは attemptCount とレート制限で止める */
    otpHash: varchar("otp_hash", { length: 64 }).notNull(),
    /** メールアドレス変更のときだけ使う、新しいアドレスの暗号文 */
    newEmailEncrypted: text("new_email_encrypted"),
    attemptCount: integer("attempt_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    requestedIpHash: varchar("requested_ip_hash", { length: 64 }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("evt_token_hash_key").on(t.tokenHash),
    index("evt_email_hmac_purpose_idx").on(t.emailHmac, t.purpose),
    index("evt_expires_at_idx").on(t.expiresAt),
    // 外部キーの参照側。無いと退会時の連鎖削除が表全体を走査する。
    index("evt_user_id_idx").on(t.userId),
  ],
);

/**
 * 退会依頼。
 *
 * ★依頼を積むだけの実装にしないこと。★ scheduledPurgeAt を過ぎた行を
 * 実際に消す定期処理（scripts/purge-accounts.ts）まで作って初めて
 * 「30日後に削除する」と言える。テストでも実際に走らせる。
 */
export const accountDeletionRequests = pgTable(
  "account_deletion_requests",
  {
    id: ulidPk(),
    userId: ulidRef("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: deletionRequestStatusEnum("status").notNull().default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    scheduledPurgeAt: timestamp("scheduled_purge_at", {
      withTimezone: true,
    }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // 「保留中の退会依頼は利用者ごとに1件だけ」を DB 側で保証する。
    // 完了済み・取消済みの履歴は何件でも残せる。
    uniqueIndex("adr_user_pending_key")
      .on(t.userId)
      .where(sql`status = 'pending'`),
    index("adr_scheduled_purge_at_idx").on(t.scheduledPurgeAt),
  ],
);

export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(userProfiles, {
    fields: [users.id],
    references: [userProfiles.userId],
  }),
  sessions: many(sessions),
}));

export const userProfilesRelations = relations(userProfiles, ({ one }) => ({
  user: one(users, {
    fields: [userProfiles.userId],
    references: [users.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));
