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
import { transitionListing } from "./listing-service.server.ts";

/**
 * 退会の実行。
 *
 * ★user_id だけで消すと消し残る。★ メール配信ログと確認トークンは
 * email_hmac で紐づいており、user_id が入っていない行がある
 * （登録前に送った確認メールなど）。片方だけ消すと
 * 「30日後に削除します」が嘘になる。
 *
 * ★users を参照する外部キーは、すべて CASCADE か SET NULL であること。★
 * RESTRICT が1つでもあると、その表に行がある人の削除が毎日失敗し続け、
 * 「30日後に消します」が永久に果たされない。admin_actions.admin_id が
 * 実際にそうなっていた（2026-08-17 の点検で発覚。SET NULL に直した。
 * 「誰が」は audit_logs に残る）。新しく users を参照する表を足すときは
 * ここを思い出すこと。失敗は握りつぶさず failed に数える。
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
      /*
       * 1. ★写真の実体（R2）を先に消す。★
       *
       * 以前は行に「削除待ち」の印をつけて別の定期処理に任せていたが、
       * 直後の投稿の物理削除で listing_images が連鎖削除され、印ごと
       * 消えていた。★R2 のオブジェクトだけが永久に取り残され、DB から
       * 辿る手段も無い★（2026-08-17 の点検で発覚）。「写真を削除します」
       * が果たされていなかった。
       *
       * R2 が1つでも消せなければこの人は今日は見送る（例外で下へ落ち、
       * 明日また試す）。DB を先に消してしまうと二度と辿れない。
       * トランザクションの外で行うのは、R2 の I/O を DB のロックの中に
       * 置かないため。
       */
      const images = await db
        .select({ objectKey: listingImages.objectKey })
        .from(listingImages)
        .where(
          sql`${listingImages.listingId} in (
            select id from listings where owner_id = ${row.userId}
          )`,
        );
      for (const image of images) {
        // 削除は冪等。存在しないキーでも成功する。
        await env.MEDIA.delete(image.objectKey);
      }

      await db.transaction(async (tx) => {
        // 2. 決済の記録は残す（法令上の保存義務）。
        //    payments.user_id / listing_id は ON DELETE SET NULL なので、
        //    本人と投稿を消すと参照だけが外れ、金額・日時・決済事業者側の
        //    識別子が残る。個人は特定できない。

        // 3. 投稿を論理削除ではなく物理削除する（本人のデータなので残さない）。
        //    listing_images の行はここで連鎖削除される（実体は上で消してある）。
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
 *
 * ★この関数は書いてあるだけで、どこからも呼ばれていなかった。★
 * 退会画面は「お申し込みの時点で掲載を終了します」と約束していたのに、
 * 嫌がらせが理由で退会する人の掲載に30日間問い合わせが届き続けた
 * （2026-08-17 の点検で発覚）。mypage.delete の action から呼ぶ。
 *
 * ★status を直接 UPDATE しない。★ 遷移は必ず transitionListing を通す
 * （published → closed / owner は遷移表にある）。直接書くと closed_at や
 * 監視の前提が崩れる。
 */
export async function closeListingsOnDeletionRequest(
  db: Db,
  userId: string,
): Promise<number> {
  const live = await db
    .select({ id: listings.id })
    .from(listings)
    .where(and(eq(listings.ownerId, userId), eq(listings.status, "published")));

  let closed = 0;
  for (const listing of live) {
    const result = await transitionListing(db, {
      listingId: listing.id,
      to: "closed",
      actor: "owner",
      expectedFrom: "published",
    });
    if (result.changed) closed += 1;
  }
  return closed;
}
