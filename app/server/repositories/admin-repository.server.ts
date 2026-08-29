import { and, desc, eq, isNull, sql } from "drizzle-orm";

import {
  adminActions,
  auditLogs,
  listings,
  userProfiles,
} from "~/db/schema/index.ts";
import type { ListingStatus } from "~/domain/listing-status";
import type { Db } from "../db.server.ts";

/**
 * 管理画面のための読み取り。
 *
 * ★個人情報を返さない。★ 一覧に必要なのは表示名と状態だけで、
 * メールアドレスは復号しない（画面に出す用途が無い）。
 */

export async function listListingsForAdmin(
  db: Db,
  options: { status?: ListingStatus; limit?: number } = {},
) {
  const conditions = [isNull(listings.deletedAt)];
  if (options.status) conditions.push(eq(listings.status, options.status));

  return db
    .select({
      id: listings.id,
      title: listings.title,
      status: listings.status,
      ownerId: listings.ownerId,
      ownerName: userProfiles.displayName,
      createdAt: listings.createdAt,
      publishedAt: listings.publishedAt,
      /*
       * ★古い行は closed_at が入っていない。★ この列を停止・却下でも
       * 入れるようにしたのは 2026-08-29 で、それ以前に止めたものは null。
       * 保持期間の掃除と同じ順で読み替える（closed_at → updated_at）。
       */
      endedAt: sql<Date>`coalesce(${listings.closedAt}, ${listings.updatedAt})`,
      moderationReason: listings.moderationReason,
    })
    .from(listings)
    .leftJoin(userProfiles, eq(userProfiles.userId, listings.ownerId))
    .where(and(...conditions))
    .orderBy(desc(listings.createdAt))
    .limit(options.limit ?? 200);
}


/**
 * 停止したまま目安の日数を過ぎた投稿の件数。
 *
 * ★停止は保持期間の対象外。★ 人が «対応が終わった» と判断して削除する
 * までずっと残る。覚えている前提の運用は成り立たないので、管理画面に出す。
 * 古い行は closed_at が無いので updated_at へ読み替える（掃除と同じ順）。
 */
export async function countSuspendedNeedingReview(
  db: Db,
  days: number,
): Promise<{ count: number; oldestDays: number }> {
  const rows = await db.execute<{ n: number; oldest: number | null }>(sql`
    select
      count(*)::int as n,
      max(
        extract(
          day from now() - coalesce(closed_at, updated_at)
        )
      )::int as oldest
    from listings
    where status = 'suspended'
      and deleted_at is null
      and coalesce(closed_at, updated_at) <= now() - make_interval(days => ${days})
  `);
  const row = rows.rows[0];
  return { count: row?.n ?? 0, oldestDays: row?.oldest ?? 0 };
}
export async function listAuditLogs(db: Db, limit = 200) {
  return db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      actorId: auditLogs.actorId,
      actorRole: auditLogs.actorRole,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}

export async function listAdminActions(db: Db, limit = 200) {
  return db
    .select({
      id: adminActions.id,
      actionType: adminActions.actionType,
      adminId: adminActions.adminId,
      targetType: adminActions.targetType,
      targetId: adminActions.targetId,
      reason: adminActions.reason,
      createdAt: adminActions.createdAt,
    })
    .from(adminActions)
    .orderBy(desc(adminActions.createdAt))
    .limit(limit);
}

/** ある投稿に対する通報件数。管理画面の一覧に添える */
export async function countReportsByListing(
  db: Db,
  listingIds: string[],
): Promise<Map<string, number>> {
  if (listingIds.length === 0) return new Map();

  const rows = await db.execute<{ target_listing_id: string; count: number }>(
    sql`select target_listing_id, count(*)::int as count
        from reports
        where target_listing_id = any(${listingIds})
        group by target_listing_id`,
  );

  const out = new Map<string, number>();
  for (const row of rows.rows) {
    out.set(row.target_listing_id, Number(row.count));
  }
  return out;
}
