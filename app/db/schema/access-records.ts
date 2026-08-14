import { index, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

import { ulidPk, ulidRef } from "./_shared.ts";

/**
 * 発信者情報の記録。
 *
 * ★ここだけは IP を復号できる形で持つ。★ 他の場所（sessions・audit_logs など）
 * は鍵付きハッシュで、元に戻せない。それは「誰かを追う」ためではなく
 * 「同じ相手か」を判定するためのものだから。
 *
 * 一方、詐欺の被害者からの発信者情報開示請求（情報流通プラットフォーム対処法）や
 * 警察の捜査関係事項照会（刑訴法197条2項）で求められるのは★IPアドレスそのもの★。
 * ハッシュしか無いと「ポリシーには開示すると書いてあるのに出せるものが無い」に
 * なる。だから、害が生じうる操作に限って、復号できる形で残す。
 *
 * ★保存は AES-GCM。生の IP は列に入れない。★ 鍵は ACCESS_LOG_KEY で、
 * セッションやメールとは別にする。1つ漏れたときの被害範囲を分けるため。
 *
 * ★保存期間は6か月。★ 期限を過ぎたものは定期処理が消す（cron の purge-access-records）。
 * 消さないと、開示のために持っているつもりの表が、そのまま漏洩時の被害になる。
 */

/** 記録する操作。増やすときはプライバシーポリシーの記載も合わせること */
export const ACCESS_RECORD_ACTIONS = [
  "signup",
  "login",
  "listing_published",
  "listing_updated",
  "message_sent",
  "report_submitted",
] as const;

export type AccessRecordAction = (typeof ACCESS_RECORD_ACTIONS)[number];

/** 保存期間（日）。プライバシーポリシーに書いてある値と必ず一致させること */
export const ACCESS_RECORD_RETENTION_DAYS = 183;

export const accessRecords = pgTable(
  "access_records",
  {
    id: ulidPk(),
    /*
     * ★users への外部キーを張らない。★ 張ると、退会で利用者を消したときに
     * 発信者情報まで一緒に消える。退会後に発覚する詐欺があるので、
     * 利用者の削除とこの表の保存期間は切り離す（audit_logs と同じ考え方）。
     */
    userId: ulidRef("user_id"),
    action: varchar("action", { length: 32 }).$type<AccessRecordAction>().notNull(),
    /** 対象の種類と ID。投稿・メッセージ・通報のどれを指すか */
    targetType: varchar("target_type", { length: 32 }),
    targetId: varchar("target_id", { length: 40 }),

    /** ★AES-GCM の暗号文。★ 生の IP は入れない */
    ipEncrypted: varchar("ip_encrypted", { length: 255 }).notNull(),
    /*
     * 同一 IP からの操作をまとめて調べるための索引。
     * 暗号文は毎回変わる（nonce があるため）ので、これが無いと
     * 「同じIPの他の投稿」を引けない。鍵付きなので総当たりでは戻せない。
     */
    ipHmac: varchar("ip_hmac", { length: 64 }).notNull(),
    userAgent: varchar("user_agent", { length: 255 }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** この時刻を過ぎたら定期処理が消す */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("access_records_user_idx").on(t.userId, t.createdAt.desc()),
    index("access_records_target_idx").on(t.targetType, t.targetId),
    index("access_records_ip_idx").on(t.ipHmac, t.createdAt.desc()),
    // 期限切れの掃除で使う
    index("access_records_expires_idx").on(t.expiresAt),
  ],
);
