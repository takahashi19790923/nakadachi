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
      moderationReason: listings.moderationReason,
    })
    .from(listings)
    .leftJoin(userProfiles, eq(userProfiles.userId, listings.ownerId))
    .where(and(...conditions))
    .orderBy(desc(listings.createdAt))
    .limit(options.limit ?? 200);
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
