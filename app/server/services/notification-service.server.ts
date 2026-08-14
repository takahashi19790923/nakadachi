import { and, eq, isNull, lte, sql } from "drizzle-orm";

import {
  conversationThreads,
  listings,
  userProfiles,
  users,
} from "~/db/schema/index.ts";
import type { Db } from "../db.server.ts";
import type { AppEnv } from "../env.server.ts";
import type { Logger } from "../logger.server.ts";
import { decryptUserEmail } from "../repositories/user-repository.server.ts";
import { sendEmail } from "./email/email-service.server.ts";
import {
  listingExpiringEmail,
  listingPublishedEmail,
  listingSuspendedEmail,
  newMessageEmail,
  paymentFailedEmail,
} from "./email/templates.server.ts";

/**
 * 通知メールの送信。
 *
 * ★どれも「送れなくても本処理は成立している」ものだけ。★
 * 掲載完了メールが送れなくても公開は取り消さない。冪等キーを持たせて
 * あるので、あとから同じ鍵で再送しても二重には届かない。
 */

async function recipientEmail(
  db: Db,
  env: AppEnv,
  userId: string,
): Promise<{ email: string; notifyOnMessage: boolean; notifyOnExpiry: boolean } | null> {
  const rows = await db
    .select({
      emailEncrypted: users.emailEncrypted,
      status: users.status,
      notifyOnMessage: userProfiles.notifyOnMessage,
      notifyOnExpiry: userProfiles.notifyOnExpiry,
    })
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);

  const row = rows[0];
  if (!row || row.status !== "active") return null;

  return {
    // ★復号はここだけ。★ 戻り値をログへ出さない。
    email: await decryptUserEmail(env, row.emailEncrypted),
    notifyOnMessage: row.notifyOnMessage ?? true,
    notifyOnExpiry: row.notifyOnExpiry ?? true,
  };
}

export async function notifyListingPublished(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  listingId: string;
  userId: string;
}): Promise<void> {
  const { db, env, logger, listingId, userId } = options;

  const rows = await db
    .select({ title: listings.title, expiresAt: listings.expiresAt })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1);
  const listing = rows[0];
  if (!listing) return;

  const recipient = await recipientEmail(db, env, userId);
  if (!recipient) return;

  await sendEmail(
    {
      template: "listing_published",
      to: recipient.email,
      content: listingPublishedEmail({
        title: listing.title,
        listingUrl: new URL(`/listings/${listingId}`, env.APP_ORIGIN).toString(),
        expiresAt: listing.expiresAt
          ? new Intl.DateTimeFormat("ja-JP", {
              dateStyle: "long",
              timeZone: "Asia/Tokyo",
            }).format(listing.expiresAt)
          : "未定",
      }),
      // ★掲載1件につき1通。★ Webhook が再送されても増えない。
      idempotencyKey: `listing_published:${listingId}`,
      userId,
      listingId,
    },
    { db, env, logger },
  );
}

export async function notifyPaymentFailed(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  listingId: string;
  userId: string;
  attempt: string;
}): Promise<void> {
  const { db, env, logger, listingId, userId } = options;

  const rows = await db
    .select({ title: listings.title })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1);
  const listing = rows[0];
  if (!listing) return;

  const recipient = await recipientEmail(db, env, userId);
  if (!recipient) return;

  await sendEmail(
    {
      template: "payment_failed",
      to: recipient.email,
      content: paymentFailedEmail({
        title: listing.title,
        retryUrl: new URL(
          `/listings/${listingId}/confirm`,
          env.APP_ORIGIN,
        ).toString(),
      }),
      // 試行ごとに1通。同じ失敗の再送では増えない。
      idempotencyKey: `payment_failed:${listingId}:${options.attempt}`,
      userId,
      listingId,
    },
    { db, env, logger },
  );
}

export async function notifyNewMessage(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  threadId: string;
  recipientId: string;
}): Promise<void> {
  const { db, env, logger, threadId, recipientId } = options;

  const recipient = await recipientEmail(db, env, recipientId);
  if (!recipient || !recipient.notifyOnMessage) return;

  const rows = await db
    .select({ title: listings.title, lastMessageAt: conversationThreads.lastMessageAt })
    .from(conversationThreads)
    .innerJoin(listings, eq(listings.id, conversationThreads.listingId))
    .where(eq(conversationThreads.id, threadId))
    .limit(1);
  const thread = rows[0];
  if (!thread) return;

  // ★1通ごとにメールを送らない。★ 会話が続いている間に何十通も届くと、
  // 通知そのものが無視されるようになる。同じ時間帯（1時間単位）では1通に
  // まとめる。
  const bucket = thread.lastMessageAt
    ? Math.floor(thread.lastMessageAt.getTime() / (60 * 60 * 1000))
    : 0;

  await sendEmail(
    {
      template: "new_message",
      to: recipient.email,
      content: newMessageEmail({
        listingTitle: thread.title,
        threadUrl: new URL(
          `/mypage/messages/${threadId}`,
          env.APP_ORIGIN,
        ).toString(),
      }),
      idempotencyKey: `new_message:${threadId}:${recipientId}:${bucket}`,
      userId: recipientId,
    },
    { db, env, logger },
  );
}

export async function notifyListingSuspended(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  listingId: string;
  reason: string;
}): Promise<void> {
  const { db, env, logger, listingId } = options;

  const rows = await db
    .select({ title: listings.title, ownerId: listings.ownerId })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1);
  const listing = rows[0];
  if (!listing) return;

  const recipient = await recipientEmail(db, env, listing.ownerId);
  if (!recipient) return;

  await sendEmail(
    {
      template: "listing_suspended",
      to: recipient.email,
      content: listingSuspendedEmail({
        title: listing.title,
        reason: options.reason,
        contactUrl: new URL("/contact", env.APP_ORIGIN).toString(),
      }),
      idempotencyKey: `listing_suspended:${listingId}:${Math.floor(Date.now() / 86_400_000)}`,
      userId: listing.ownerId,
      listingId,
    },
    { db, env, logger },
  );
}

/**
 * 掲載期限の予告。定期処理から呼ぶ。
 * 期限の3日前に1通だけ送る（冪等キーに日付を含める）。
 */
export async function notifyExpiringListings(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  daysBefore?: number;
  limit?: number;
}): Promise<number> {
  const { db, env, logger } = options;
  const daysBefore = options.daysBefore ?? 3;

  const threshold = new Date(Date.now() + daysBefore * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: listings.id,
      title: listings.title,
      ownerId: listings.ownerId,
      expiresAt: listings.expiresAt,
    })
    .from(listings)
    .where(
      and(
        eq(listings.status, "published"),
        isNull(listings.deletedAt),
        lte(listings.expiresAt, threshold),
        sql`${listings.expiresAt} > now()`,
      ),
    )
    .limit(options.limit ?? 200);

  let sent = 0;
  for (const row of rows) {
    const recipient = await recipientEmail(db, env, row.ownerId);
    if (!recipient || !recipient.notifyOnExpiry) continue;

    const result = await sendEmail(
      {
        template: "listing_expiring",
        to: recipient.email,
        content: listingExpiringEmail({
          title: row.title,
          listingUrl: new URL(`/listings/${row.id}`, env.APP_ORIGIN).toString(),
          daysLeft: daysBefore,
        }),
        idempotencyKey: `listing_expiring:${row.id}:${daysBefore}`,
        userId: row.ownerId,
        listingId: row.id,
      },
      { db, env, logger },
    );
    if (result.sent) sent += 1;
  }
  return sent;
}
