import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { blocks, favorites, listings } from "~/db/schema/index.ts";
import type { ListingSummary } from "~/domain/listing-types";
import type { Db } from "../db.server.ts";
import { AppError, notFound } from "../errors.ts";
import { listByOwner } from "../repositories/listing-repository.server.ts";

/**
 * お気に入りとブロック。
 *
 * どちらも「押した／押していない」の2状態しかないので、切り替えは
 * ★冪等に作る★（同じ操作を2回受けても同じ結果になる）。連打や
 * 二重送信で行が増えたり例外になったりしないようにする。
 */

export async function toggleFavorite(options: {
  db: Db;
  userId: string;
  listingId: string;
  desired: "add" | "remove";
}): Promise<{ favorited: boolean }> {
  const { db, userId, listingId } = options;

  if (options.desired === "remove") {
    await db
      .delete(favorites)
      .where(
        and(eq(favorites.userId, userId), eq(favorites.listingId, listingId)),
      );
    return { favorited: false };
  }

  // 公開中の投稿だけをお気に入りにできる。下書きの ID を送られても増えない。
  const exists = await db
    .select({ id: listings.id })
    .from(listings)
    .where(
      and(
        eq(listings.id, listingId),
        eq(listings.status, "published"),
        isNull(listings.deletedAt),
      ),
    )
    .limit(1);

  if (exists.length === 0) {
    throw notFound(`favorite target not available: ${listingId}`);
  }

  await db
    .insert(favorites)
    .values({ userId, listingId })
    .onConflictDoNothing();

  return { favorited: true };
}

export async function isFavorited(
  db: Db,
  userId: string,
  listingId: string,
): Promise<boolean> {
  const rows = await db
    .select({ listingId: favorites.listingId })
    .from(favorites)
    .where(and(eq(favorites.userId, userId), eq(favorites.listingId, listingId)))
    .limit(1);
  return rows.length === 1;
}

/**
 * お気に入り一覧。
 * 掲載が終わったものも残す（「あの投稿はどうなったか」を追えるようにする）。
 */
export async function listFavorites(
  db: Db,
  userId: string,
): Promise<{ listingId: string; createdAt: string }[]> {
  const rows = await db
    .select({ listingId: favorites.listingId, createdAt: favorites.createdAt })
    .from(favorites)
    .where(eq(favorites.userId, userId))
    .orderBy(desc(favorites.createdAt))
    .limit(200);

  return rows.map((row) => ({
    listingId: row.listingId,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function setBlock(options: {
  db: Db;
  blockerId: string;
  blockedId: string;
  intent: "block" | "unblock";
  reason?: string;
}): Promise<void> {
  const { db, blockerId, blockedId } = options;

  if (blockerId === blockedId) {
    throw new AppError("validation_failed", "自分自身はブロックできません。", {
      detail: "self block attempted",
    });
  }

  if (options.intent === "unblock") {
    await db
      .delete(blocks)
      .where(
        and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)),
      );
    return;
  }

  await db
    .insert(blocks)
    .values({ blockerId, blockedId, reason: options.reason ?? null })
    .onConflictDoNothing();
}

export async function listBlockedUsers(db: Db, blockerId: string) {
  return db
    .select({ blockedId: blocks.blockedId, createdAt: blocks.createdAt })
    .from(blocks)
    .where(eq(blocks.blockerId, blockerId))
    .orderBy(desc(blocks.createdAt))
    .limit(200);
}

/** マイページの件数表示。1回の問い合わせでまとめて数える */
export async function getMypageCounts(
  db: Db,
  userId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: listings.status, count: sql<number>`count(*)::int` })
    .from(listings)
    .where(and(eq(listings.ownerId, userId), isNull(listings.deletedAt)))
    .groupBy(listings.status);

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

/** マイページの各タブ。状態の組み合わせをここに集約する */
export const MYPAGE_TABS = {
  drafts: ["draft", "payment_pending", "payment_processing"],
  published: ["published"],
  finished: ["closed", "expired", "rejected", "suspended"],
} as const;

export async function listOwnListings(
  db: Db,
  userId: string,
  tab: keyof typeof MYPAGE_TABS,
): Promise<ListingSummary[]> {
  return listByOwner(db, userId, [...MYPAGE_TABS[tab]]);
}
