import { and, eq, lte, sql } from "drizzle-orm";

import {
  accountDeletionRequests,
  emailDeliveryLogs,
  emailVerificationTokens,
  listingImages,
  listings,
  users,
} from "~/db/schema/index.ts";
import { writeAuditLog } from "../audit.server.ts";
import type { Db } from "../db.server.ts";
import type { AppEnv } from "../env.server.ts";
import type { Logger } from "../logger.server.ts";

/**
 * 退会の実行。
 *
 * ★user_id だけで消すと消し残る。★ メール配信ログと確認トークンは
 * email_hmac で紐づいており、user_id が入っていない行がある
 * （登録前に送った確認メールなど）。片方だけ消すと
 * 「30日後に削除します」が嘘になる。
 *
 * ★外部キーの順序に注意。★ 所有関係が RESTRICT の表があるので、
 * 先に子を消してから本人を消す。順序を誤ると毎回失敗するが、
 * try/catch に握られると誰も気づかない。だからここでは握りつぶさない。
 *
 * ★監査ログには個人情報を書かない。★ 消した意味が無くなる。
 */
export async function purgeDueAccounts(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  limit?: number;
}): Promise<{ purged: number; failed: number }> {
  const { db, env, logger } = options;

  const due = await db
    .select({
      requestId: accountDeletionRequests.id,
      userId: accountDeletionRequests.userId,
      emailHmac: users.emailHmac,
    })
    .from(accountDeletionRequests)
    .innerJoin(users, eq(users.id, accountDeletionRequests.userId))
    .where(
      and(
        eq(accountDeletionRequests.status, "pending"),
        lte(accountDeletionRequests.scheduledPurgeAt, new Date()),
      ),
    )
    .limit(options.limit ?? 50);

  let purged = 0;
  let failed = 0;

  for (const row of due) {
    try {
      await db.transaction(async (tx) => {
        // 1. 画像は実体の削除待ちに入れる（R2 の掃除は別の定期処理）。
        await tx
          .update(listingImages)
          .set({ deletedAt: new Date(), purgeAfter: new Date() })
          .where(
            sql`${listingImages.listingId} in (
              select id from listings where owner_id = ${row.userId}
            )`,
          );

        // 2. 決済の記録は残す（法令上の保存義務）。
        //    payments.user_id / listing_id は ON DELETE SET NULL なので、
        //    本人と投稿を消すと参照だけが外れ、金額・日時・決済事業者側の
        //    識別子が残る。個人は特定できない。

        // 3. 投稿を論理削除ではなく物理削除する（本人のデータなので残さない）。
        await tx.delete(listings).where(eq(listings.ownerId, row.userId));

        // 4. ★email_hmac で紐づく行。★ user_id では辿れないものがある。
        await tx
          .delete(emailVerificationTokens)
          .where(eq(emailVerificationTokens.emailHmac, row.emailHmac));
        await tx
          .delete(emailDeliveryLogs)
          .where(eq(emailDeliveryLogs.recipientHmac, row.emailHmac));

        // 5. 本人。session / profile / favorites / messages などは
        //    ON DELETE CASCADE で一緒に消える。
        await tx.delete(users).where(eq(users.id, row.userId));

        // 6. 依頼を完了にする。★users を消したあとに更新する行なので、
        //    accountDeletionRequests は CASCADE で消えている。記録として
        //    残したい場合は別表に移すこと（現状は監査ログで代替）。
      });

      await writeAuditLog(db, env, {
        action: "account.purged",
        actorRole: "system",
        targetType: "user",
        // ★ID すら残さない。★ 消した事実と件数だけで運用は成り立つ。
        metadata: { requestId: row.requestId.slice(0, 8) },
      });

      purged += 1;
    } catch (error) {
      // ★握りつぶさない。★ 消えないまま「消えたつもり」になるのが最悪。
      failed += 1;
      logger.error("account purge failed", error, {
        requestId: row.requestId.slice(0, 8),
      });
    }
  }

  return { purged, failed };
}

/**
 * 退会を申し込んだ時点で、公開中の投稿を止める。
 * 30日間そのまま掲載され続けるのは利用者の期待と合わない。
 */
export async function closeListingsOnDeletionRequest(
  db: Db,
  userId: string,
): Promise<number> {
  const result = await db
    .update(listings)
    .set({ status: "closed", closedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(listings.ownerId, userId), eq(listings.status, "published")));
  return result.rowCount ?? 0;
}
