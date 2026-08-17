import { relations } from "drizzle-orm";
import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import { softDelete, timestamps, ulidPk, ulidRef } from "./_shared.ts";
import { threadParticipantRoleEnum } from "./enums.ts";
import { listings } from "./listings.ts";
import { users } from "./users.ts";

/**
 * 会話スレッド。投稿ごと・問い合わせた人ごとに1本。
 *
 * (listingId, initiatorId) に一意制約を置いているので、同じ人が同じ投稿へ
 * 何度問い合わせても会話は1本にまとまる。
 */
export const conversationThreads = pgTable(
  "conversation_threads",
  {
    id: ulidPk(),
    listingId: ulidRef("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    /** 問い合わせた側。投稿者ではない */
    initiatorId: ulidRef("initiator_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex("threads_listing_initiator_key").on(t.listingId, t.initiatorId),
    index("threads_listing_idx").on(t.listingId),
    // 外部キーの参照側。無いと退会時の連鎖削除が表全体を走査する。
    index("threads_initiator_idx").on(t.initiatorId),
    index("threads_last_message_idx").on(t.lastMessageAt.desc()),
  ],
);

/**
 * 会話の当事者。
 *
 * ★閲覧できるかどうかは、必ずこの表を引いて判断する。★
 * 「投稿の所有者だから」「スレッドを作った人だから」といった条件を
 * 各画面で書き直すと、どこか1つで抜ける。参加者表への所属が唯一の根拠。
 */
export const conversationParticipants = pgTable(
  "conversation_participants",
  {
    threadId: ulidRef("thread_id")
      .notNull()
      .references(() => conversationThreads.id, { onDelete: "cascade" }),
    userId: ulidRef("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: threadParticipantRoleEnum("role").notNull(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.userId] }),
    index("participants_user_idx").on(t.userId),
  ],
);

/**
 * メッセージ。
 *
 * ★本文はプレーンテキストとしてのみ保存し、HTML として描画しない。★
 * React は既定で文字列をエスケープするので、dangerouslySetInnerHTML を
 * 使わない限り安全。改行だけを表示側で反映する。
 *
 * 送信者はセッションから決める。リクエストの本文に senderId を入れさせない。
 */
export const messages = pgTable(
  "messages",
  {
    id: ulidPk(),
    threadId: ulidRef("thread_id")
      .notNull()
      .references(() => conversationThreads.id, { onDelete: "cascade" }),
    senderId: ulidRef("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    ...timestamps(),
    ...softDelete(),
    /** 誰が消したか（本人か管理者か）。監査のため残す */
    deletedBy: ulidRef("deleted_by"),
  },
  (t) => [
    index("messages_thread_created_idx").on(t.threadId, t.createdAt),
    index("messages_sender_idx").on(t.senderId),
  ],
);

/**
 * ブロック。
 *
 * blocker が blocked からのメッセージ・問い合わせを受け取らなくなる。
 * 「ブロックしたこと」を相手に知らせない（通知しない）。
 */
export const blocks = pgTable(
  "blocks",
  {
    blockerId: ulidRef("blocker_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedId: ulidRef("blocked_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: varchar("reason", { length: 200 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.blockerId, t.blockedId] }),
    index("blocks_blocked_idx").on(t.blockedId),
  ],
);

export const threadsRelations = relations(
  conversationThreads,
  ({ one, many }) => ({
    listing: one(listings, {
      fields: [conversationThreads.listingId],
      references: [listings.id],
    }),
    participants: many(conversationParticipants),
    messages: many(messages),
  }),
);

export const participantsRelations = relations(
  conversationParticipants,
  ({ one }) => ({
    thread: one(conversationThreads, {
      fields: [conversationParticipants.threadId],
      references: [conversationThreads.id],
    }),
    user: one(users, {
      fields: [conversationParticipants.userId],
      references: [users.id],
    }),
  }),
);

export const messagesRelations = relations(messages, ({ one }) => ({
  thread: one(conversationThreads, {
    fields: [messages.threadId],
    references: [conversationThreads.id],
  }),
  sender: one(users, { fields: [messages.senderId], references: [users.id] }),
}));
