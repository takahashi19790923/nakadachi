import { and, desc, eq, isNull, or, sql } from "drizzle-orm";

import {
  blocks,
  conversationParticipants,
  conversationThreads,
  listings,
  messages,
  userProfiles,
} from "~/db/schema/index.ts";
import { ulid } from "~/domain/ulid.ts";
import type { Db } from "../db.server.ts";
import { AppError, notFound } from "../errors.ts";
import {
  createSystemReport,
  findBlockingWord,
  findFlaggedWords,
} from "../repositories/moderation-repository.server.ts";

/**
 * サイト内メッセージ。
 *
 * 守っていること
 *  - ★閲覧できるかは conversation_participants への所属だけで判断する。★
 *    「投稿者だから」「作った人だから」を各画面で書き直すと、どこかで抜ける
 *  - ★送信者はセッションから決める。★ リクエスト本文の senderId を使わない
 *  - ★本文はプレーンテキストとしてのみ保存・描画する。★ HTML にしない
 *  - ブロックしている相手からは受け取らない（ブロックを相手に知らせない）
 */

export interface ThreadSummary {
  readonly id: string;
  readonly listingId: string;
  readonly listingTitle: string;
  readonly listingStatus: string;
  readonly counterpartName: string;
  readonly lastMessageAt: string | null;
  readonly unread: boolean;
}

/**
 * 投稿への問い合わせスレッドを用意する。
 * 同じ人が同じ投稿へ何度問い合わせても、会話は1本にまとまる。
 */
export async function ensureThread(options: {
  db: Db;
  listingId: string;
  inquirerId: string;
}): Promise<{ threadId: string }> {
  const { db, listingId, inquirerId } = options;

  const listingRows = await db
    .select({ ownerId: listings.ownerId, status: listings.status })
    .from(listings)
    .where(and(eq(listings.id, listingId), isNull(listings.deletedAt)))
    .limit(1);

  const listing = listingRows[0];
  if (!listing) throw notFound(`listing not found: ${listingId}`);

  if (listing.ownerId === inquirerId) {
    throw new AppError("validation_failed", "自分の投稿には問い合わせできません。", {
      detail: "owner tried to contact own listing",
    });
  }
  if (listing.status !== "published") {
    throw new AppError(
      "conflict",
      "この投稿は現在お問い合わせを受け付けていません。",
      { detail: `contact attempted on status=${listing.status}` },
    );
  }

  // ★どちらか一方でもブロックしていれば会話を開かない。★
  const blocked = await db
    .select({ blockerId: blocks.blockerId })
    .from(blocks)
    .where(
      or(
        and(
          eq(blocks.blockerId, listing.ownerId),
          eq(blocks.blockedId, inquirerId),
        ),
        and(
          eq(blocks.blockerId, inquirerId),
          eq(blocks.blockedId, listing.ownerId),
        ),
      ),
    )
    .limit(1);

  if (blocked.length > 0) {
    // ブロックされている側に、その事実を伝えない文言にする。
    throw new AppError(
      "conflict",
      "この投稿にはお問い合わせできません。",
      { detail: "blocked relationship" },
    );
  }

  const existing = await db
    .select({ id: conversationThreads.id })
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.listingId, listingId),
        eq(conversationThreads.initiatorId, inquirerId),
      ),
    )
    .limit(1);

  const found = existing[0];
  if (found) return { threadId: found.id };

  const threadId = ulid();
  await db.transaction(async (tx) => {
    await tx.insert(conversationThreads).values({
      id: threadId,
      listingId,
      initiatorId: inquirerId,
    });
    await tx.insert(conversationParticipants).values([
      { threadId, userId: listing.ownerId, role: "owner" },
      { threadId, userId: inquirerId, role: "inquirer" },
    ]);
  });

  return { threadId };
}

/** その利用者が当事者かどうか。閲覧・送信の唯一の根拠 */
export async function isParticipant(
  db: Db,
  threadId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.threadId, threadId),
        eq(conversationParticipants.userId, userId),
      ),
    )
    .limit(1);
  return rows.length === 1;
}

export async function listThreadsForUser(
  db: Db,
  userId: string,
): Promise<ThreadSummary[]> {
  const rows = await db
    .select({
      id: conversationThreads.id,
      listingId: conversationThreads.listingId,
      listingTitle: listings.title,
      listingStatus: listings.status,
      lastMessageAt: conversationThreads.lastMessageAt,
      lastReadAt: conversationParticipants.lastReadAt,
      counterpartName: sql<string>`(
        select coalesce(p.display_name, '退会したユーザー')
        from conversation_participants cp
        left join user_profiles p on p.user_id = cp.user_id
        where cp.thread_id = ${conversationThreads.id}
          and cp.user_id <> ${userId}
        limit 1
      )`,
    })
    .from(conversationParticipants)
    .innerJoin(
      conversationThreads,
      eq(conversationThreads.id, conversationParticipants.threadId),
    )
    .innerJoin(listings, eq(listings.id, conversationThreads.listingId))
    .where(
      and(
        eq(conversationParticipants.userId, userId),
        isNull(conversationThreads.deletedAt),
      ),
    )
    .orderBy(desc(conversationThreads.lastMessageAt))
    .limit(100);

  return rows.map((row) => ({
    id: row.id,
    listingId: row.listingId,
    listingTitle: row.listingTitle,
    listingStatus: row.listingStatus,
    counterpartName: row.counterpartName,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    unread:
      row.lastMessageAt !== null &&
      (row.lastReadAt === null || row.lastReadAt < row.lastMessageAt),
  }));
}

export interface MessageView {
  readonly id: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly body: string | null;
  readonly createdAt: string;
  readonly deleted: boolean;
}

/**
 * 会話を読む。
 * @param viewerRole 管理者が通報対応で開く場合は "admin"。監査ログを残すこと。
 */
export async function getThreadMessages(options: {
  db: Db;
  threadId: string;
  viewerId: string;
  viewerRole: "user" | "admin";
}): Promise<{
  listingId: string;
  listingTitle: string;
  messages: MessageView[];
}> {
  const { db, threadId, viewerId, viewerRole } = options;

  if (viewerRole !== "admin") {
    const allowed = await isParticipant(db, threadId, viewerId);
    // 当事者でなければ存在も知らせない。
    if (!allowed) throw notFound(`thread access denied: ${threadId}`);
  }

  const threadRows = await db
    .select({
      listingId: conversationThreads.listingId,
      listingTitle: listings.title,
    })
    .from(conversationThreads)
    .innerJoin(listings, eq(listings.id, conversationThreads.listingId))
    .where(eq(conversationThreads.id, threadId))
    .limit(1);

  const thread = threadRows[0];
  if (!thread) throw notFound(`thread not found: ${threadId}`);

  const rows = await db
    .select({
      id: messages.id,
      senderId: messages.senderId,
      senderName: userProfiles.displayName,
      body: messages.body,
      createdAt: messages.createdAt,
      deletedAt: messages.deletedAt,
    })
    .from(messages)
    .leftJoin(userProfiles, eq(userProfiles.userId, messages.senderId))
    .where(eq(messages.threadId, threadId))
    .orderBy(messages.createdAt)
    .limit(500);

  return {
    listingId: thread.listingId,
    listingTitle: thread.listingTitle,
    messages: rows.map((row) => ({
      id: row.id,
      senderId: row.senderId,
      senderName: row.senderName ?? "退会したユーザー",
      // 削除済みは本文を返さない。「削除されました」とだけ見せる。
      body: row.deletedAt ? null : row.body,
      createdAt: row.createdAt.toISOString(),
      deleted: row.deletedAt !== null,
    })),
  };
}

export async function sendMessage(options: {
  db: Db;
  threadId: string;
  senderId: string;
  body: string;
}): Promise<{ messageId: string }> {
  const { db, threadId, senderId, body } = options;

  const allowed = await isParticipant(db, threadId, senderId);
  if (!allowed) throw notFound(`send denied: ${threadId}`);

  const blockedWord = await findBlockingWord(db, body);
  if (blockedWord) {
    throw new AppError(
      "validation_failed",
      "送信できない内容が含まれています。",
      { fields: { body: "送信できない語句が含まれています" } },
    );
  }

  /*
   * ★severity=flag の語。★ 送信は通すが、管理者の確認待ちに入れる。
   *
   * 2026-08-28 まで findFlaggedWords はどこからも呼ばれておらず、
   * ★flag として登録された語は検知しても何も起きなかった★
   * （本番に6件あった）。管理者は「登録したから見張られている」と
   * 思っているのに、実際には素通りしていた。
   *
   * 語そのものは detail に書かない。通報一覧は本文を持たない画面で、
   * そこに禁止語を並べると、対応する人の目に不快な語だけが集まる。
   */
  const flagged = await findFlaggedWords(db, body);

  // 相手がこちらをブロックしていれば送れない。
  const counterpart = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.threadId, threadId),
        sql`${conversationParticipants.userId} <> ${senderId}`,
      ),
    )
    .limit(1);

  const otherId = counterpart[0]?.userId;
  if (otherId) {
    const blockedRows = await db
      .select({ blockerId: blocks.blockerId })
      .from(blocks)
      .where(
        or(
          and(eq(blocks.blockerId, otherId), eq(blocks.blockedId, senderId)),
          and(eq(blocks.blockerId, senderId), eq(blocks.blockedId, otherId)),
        ),
      )
      .limit(1);
    if (blockedRows.length > 0) {
      throw new AppError("conflict", "この相手にはメッセージを送れません。", {
        detail: "blocked relationship",
      });
    }
  }

  const messageId = ulid();
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(messages).values({
      id: messageId,
      threadId,
      senderId,
      body,
    });
    await tx
      .update(conversationThreads)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(conversationThreads.id, threadId));
    // 自分が送った分は既読にしておく（自分宛の未読として数えない）。
    await tx
      .update(conversationParticipants)
      .set({ lastReadAt: now })
      .where(
        and(
          eq(conversationParticipants.threadId, threadId),
          eq(conversationParticipants.userId, senderId),
        ),
      );
  });

  /*
   * ★メッセージを保存してから通報を作る。★ 先に作ると、保存に失敗した
   * ときに存在しないメッセージを指す通報が残る（外部キーで落ちる）。
   * 通報の作成に失敗しても送信そのものは成立させる（記録はログに残る）。
   */
  if (flagged.length > 0) {
    await createSystemReport(db, {
      target: { type: "message", id: messageId },
      reason: "other",
      detail: `自動検知：要確認の語を ${flagged.length} 件含みます`,
    });
  }

  return { messageId };
}

export async function markThreadRead(
  db: Db,
  threadId: string,
  userId: string,
): Promise<void> {
  await db
    .update(conversationParticipants)
    .set({ lastReadAt: new Date() })
    .where(
      and(
        eq(conversationParticipants.threadId, threadId),
        eq(conversationParticipants.userId, userId),
      ),
    );
}

/** 送信者本人か管理者による削除。物理削除はしない */
export async function deleteMessage(options: {
  db: Db;
  messageId: string;
  actorId: string;
  actorRole: "user" | "admin";
}): Promise<void> {
  const { db, messageId, actorId, actorRole } = options;

  const rows = await db
    .select({ senderId: messages.senderId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound(`message not found: ${messageId}`);
  if (actorRole !== "admin" && row.senderId !== actorId) {
    throw notFound(`message delete denied: ${messageId}`);
  }

  await db
    .update(messages)
    .set({ deletedAt: new Date(), deletedBy: actorId })
    .where(eq(messages.id, messageId));
}

/** 相手の投稿に紐づくスレッドの相手方。通知メールの宛先を引くのに使う */
export async function getCounterpartUserId(
  db: Db,
  threadId: string,
  senderId: string,
): Promise<string | null> {
  const rows = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.threadId, threadId),
        sql`${conversationParticipants.userId} <> ${senderId}`,
      ),
    )
    .limit(1);
  return rows[0]?.userId ?? null;
}
