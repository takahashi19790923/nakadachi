import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import { timestamps, ulidPk, ulidRef } from "./_shared.ts";
import {
  bannedWordSeverityEnum,
  reportReasonEnum,
  reportStatusEnum,
  reportTargetTypeEnum,
} from "./enums.ts";
import { listings } from "./listings.ts";
import { messages } from "./messaging.ts";
import { users } from "./users.ts";

/**
 * 通報。
 *
 * 対象は投稿・メッセージ・利用者の3種類。対象ごとに別々の外部キー列を持ち、
 * ★「ちょうど1つだけ埋まっている」ことを CHECK 制約で保証する★。
 * 1本の汎用 targetId にすると外部キーが張れず、消えた対象を指したままの
 * 行が残る。
 */
export const reports = pgTable(
  "reports",
  {
    id: ulidPk(),
    reporterId: ulidRef("reporter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetType: reportTargetTypeEnum("target_type").notNull(),
    targetListingId: ulidRef("target_listing_id").references(() => listings.id, {
      onDelete: "cascade",
    }),
    targetMessageId: ulidRef("target_message_id").references(() => messages.id, {
      onDelete: "cascade",
    }),
    targetUserId: ulidRef("target_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    reason: reportReasonEnum("reason").notNull(),
    detail: varchar("detail", { length: 1000 }),
    status: reportStatusEnum("status").notNull().default("open"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: ulidRef("resolved_by"),
    resolutionNote: text("resolution_note"),
    ...timestamps(),
  },
  (t) => [
    check(
      "reports_exactly_one_target",
      sql`(
        (case when ${t.targetListingId} is null then 0 else 1 end)
      + (case when ${t.targetMessageId} is null then 0 else 1 end)
      + (case when ${t.targetUserId} is null then 0 else 1 end)
      ) = 1`,
    ),
    // 同じ人が同じ投稿を何度も通報して一覧を埋めるのを防ぐ。
    uniqueIndex("reports_reporter_listing_key")
      .on(t.reporterId, t.targetListingId)
      .where(sql`target_listing_id is not null`),
    index("reports_status_created_idx").on(t.status, t.createdAt.desc()),
    // 管理画面の「状態を絞らない一覧」は created_at だけで並べる。
    // (status, created_at) の索引は先頭が status なので、これには使えない。
    index("reports_created_idx").on(t.createdAt.desc()),
    index("reports_target_listing_idx").on(t.targetListingId),
    index("reports_target_user_idx").on(t.targetUserId),
    // 通報されたメッセージ／通報者から引く。外部キーの参照側は
    // Postgres が索引を作らないので、退会時の連鎖削除が表全体を走査する。
    index("reports_target_message_idx").on(t.targetMessageId),
    index("reports_reporter_created_idx").on(t.reporterId, t.createdAt.desc()),
  ],
);

/**
 * 禁止ワード。
 *
 * severity=block は投稿・メッセージを拒否し、flag は通して管理者の確認待ちに
 * 入れる。日本語は表記ゆれが多く、機械的な遮断だけでは取りこぼす。
 * 「これで十分」とは考えず、通報と管理者の目視と併用する前提。
 */
export const bannedWords = pgTable(
  "banned_words",
  {
    id: ulidPk(),
    word: varchar("word", { length: 60 }).notNull(),
    severity: bannedWordSeverityEnum("severity").notNull().default("flag"),
    note: varchar("note", { length: 200 }),
    createdBy: ulidRef("created_by"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("banned_words_word_key").on(t.word)],
);
