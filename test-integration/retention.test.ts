import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  emailDeliveryLogs,
  listingImages,
  listings,
  payments,
  paymentWebhookEvents,
} from "~/db/schema/index.ts";
import { LISTING_FEE_JPY } from "~/domain/pricing";
import {
  IMAGE_RETENTION_DAYS,
  LISTING_RETENTION_DAYS,
  PAYMENT_RETENTION_DAYS,
} from "~/domain/retention";
import { ulid } from "~/domain/ulid";
import type { Db } from "~/server/db.server";
import {
  markEndedListingImages,
  purgeEndedListings,
  purgeOldEmailLogs,
  purgeOldPayments,
  purgeOldWebhookEvents,
  purgeResolvedReports,
} from "~/server/services/retention-service.server";
import { closeTestDb, makeDraft, makeUser, resetDatabase } from "./helpers.ts";

/**
 * 保持期間の掃除。
 *
 * ★実際の DB へ当てる。★ 生の SQL を書いているので、モックでは
 * 綴りの間違いも連鎖削除の挙動も分からない。
 */
let db: Db;
let userId: string;

beforeEach(async () => {
  db = await resetDatabase();
  const user = await makeUser(db, "retention@example.test");
  userId = user.id;
});

afterAll(async () => {
  await closeTestDb();
});

/** 指定日数前に終了した掲載を作る */
async function makeEndedListing(daysAgo: number, status = "closed") {
  const id = await makeDraft(db, userId, { status: status as "closed" });
  await db.execute(sql`
    update listings
    set closed_at = now() - make_interval(days => ${daysAgo}),
        updated_at = now() - make_interval(days => ${daysAgo})
    where id = ${id}
  `);
  return id;
}

async function addImage(listingId: string) {
  const id = ulid();
  await db.insert(listingImages).values({
    id,
    listingId,
    objectKey: `test/${id}.webp`,
    contentType: "image/webp",
    byteSize: 1000,
    width: 100,
    height: 100,
    checksumSha256: "a".repeat(64),
  });
  return id;
}

async function listingExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: listings.id })
    .from(listings)
    .where(eq(listings.id, id));
  return rows.length > 0;
}

describe("写真の掃除（掲載終了から90日）", () => {
  it("期間を過ぎた掲載の写真に削除待ちの印がつく", async () => {
    const old = await makeEndedListing(IMAGE_RETENTION_DAYS + 1);
    const imageId = await addImage(old);

    expect(await markEndedListingImages(db)).toBe(1);

    const rows = await db
      .select({ purgeAfter: listingImages.purgeAfter })
      .from(listingImages)
      .where(eq(listingImages.id, imageId));
    expect(rows[0]!.purgeAfter).not.toBeNull();
  });

  it("期間内の掲載の写真には触らない", async () => {
    const recent = await makeEndedListing(IMAGE_RETENTION_DAYS - 5);
    await addImage(recent);
    expect(await markEndedListingImages(db)).toBe(0);
  });

  it("★公開中の掲載の写真には触らない★", async () => {
    // 掲載が終わっていなければ、いくら古くても消さない。
    const live = await makeDraft(db, userId, { status: "published" });
    await db.execute(sql`
      update listings set updated_at = now() - make_interval(days => 400)
      where id = ${live}
    `);
    await addImage(live);
    expect(await markEndedListingImages(db)).toBe(0);
  });

  it("★停止中（suspended）の掲載には触らない★", async () => {
    // 返金・係争で止めたもの。経緯を追えなくなるので期間では消さない。
    const suspended = await makeEndedListing(400, "suspended");
    await addImage(suspended);
    expect(await markEndedListingImages(db)).toBe(0);
  });
});

describe("掲載の掃除（掲載終了から180日）", () => {
  it("期間を過ぎた掲載は消える", async () => {
    const old = await makeEndedListing(LISTING_RETENTION_DAYS + 1);
    expect(await purgeEndedListings(db)).toBe(1);
    expect(await listingExists(old)).toBe(false);
  });

  it("期間内の掲載は残る", async () => {
    const recent = await makeEndedListing(LISTING_RETENTION_DAYS - 5);
    expect(await purgeEndedListings(db)).toBe(0);
    expect(await listingExists(recent)).toBe(true);
  });

  it("★写真が残っている掲載は消さない★", async () => {
    /*
     * 消すと listing_images が連鎖削除され、R2 の実体だけが取り残される。
     * どこからも参照されない課金対象が永久に残り、誰も気づけない。
     */
    const old = await makeEndedListing(LISTING_RETENTION_DAYS + 1);
    await addImage(old);

    expect(await purgeEndedListings(db)).toBe(0);
    expect(await listingExists(old)).toBe(true);

    // 写真を消せば、次の回で掲載も消える。
    await db.delete(listingImages).where(eq(listingImages.listingId, old));
    expect(await purgeEndedListings(db)).toBe(1);
    expect(await listingExists(old)).toBe(false);
  });

  it("★決済記録は掲載を消しても残る（帳簿として7年保持）★", async () => {
    const old = await makeEndedListing(LISTING_RETENTION_DAYS + 1);
    const paymentId = ulid();
    await db.insert(payments).values({
      id: paymentId,
      listingId: old,
      userId,
      provider: "stripe",
      checkoutSessionId: `cs_test_${paymentId}`,
      amountJpy: LISTING_FEE_JPY,
      currency: "jpy",
      status: "succeeded",
    });

    await purgeEndedListings(db);

    const rows = await db
      .select({
        id: payments.id,
        listingId: payments.listingId,
        amountJpy: payments.amountJpy,
      })
      .from(payments)
      .where(eq(payments.id, paymentId));
    expect(rows).toHaveLength(1);
    // 参照は外れるが、金額は残る。
    expect(rows[0]!.listingId).toBeNull();
    expect(rows[0]!.amountJpy).toBe(LISTING_FEE_JPY);
  });
});

describe("運用データの掃除", () => {
  it("Webhook のイベント記録は90日で消える", async () => {
    await db.insert(paymentWebhookEvents).values({
      id: ulid(),
      provider: "stripe",
      eventId: "evt_old",
      eventType: "checkout.session.completed",
      payloadDigest: "b".repeat(64),
      status: "processed",
    });
    await db.execute(sql`
      update payment_webhook_events
      set created_at = now() - make_interval(days => 100)
    `);
    expect(await purgeOldWebhookEvents(db)).toBe(1);
  });

  it("新しいイベント記録は残る", async () => {
    await db.insert(paymentWebhookEvents).values({
      id: ulid(),
      provider: "stripe",
      eventId: "evt_new",
      eventType: "checkout.session.completed",
      payloadDigest: "c".repeat(64),
      status: "processed",
    });
    expect(await purgeOldWebhookEvents(db)).toBe(0);
  });

  it("メール送信ログは90日で消える", async () => {
    await db.insert(emailDeliveryLogs).values({
      id: ulid(),
      template: "listing_published",
      // 宛先そのものは持たない（鍵付きハッシュだけ）。
      recipientHmac: "d".repeat(64),
      idempotencyKey: `k_${ulid()}`,
      status: "sent",
    });
    await db.execute(sql`
      update email_delivery_logs
      set created_at = now() - make_interval(days => 100)
    `);
    expect(await purgeOldEmailLogs(db)).toBe(1);
  });

  it("★未対応の通報は期間で消さない★", async () => {
    // 放置された通報が静かに消えて「対応済み」になるのを防ぐ。
    const listingId = await makeDraft(db, userId, { status: "published" });
    await db.execute(sql`
      insert into reports
        (id, reporter_id, target_type, target_listing_id, reason, status, created_at)
      values
        (${ulid()}, ${userId}, 'listing', ${listingId}, 'spam', 'open',
         now() - make_interval(days => 400))
    `);
    expect(await purgeResolvedReports(db)).toBe(0);
  });
});

describe("★決済記録は7年残す★", () => {
  async function makePayment(daysAgo: number) {
    const paymentId = ulid();
    await db.insert(payments).values({
      id: paymentId,
      listingId: null,
      userId,
      provider: "stripe",
      checkoutSessionId: `cs_test_${paymentId}`,
      amountJpy: LISTING_FEE_JPY,
      currency: "jpy",
      status: "succeeded",
    });
    await db.execute(sql`
      update payments set created_at = now() - make_interval(days => ${daysAgo})
      where id = ${paymentId}
    `);
    return paymentId;
  }

  it("6年前の決済は消さない", async () => {
    await makePayment(365 * 6);
    expect(await purgeOldPayments(db)).toBe(0);
  });

  it("7年を過ぎた決済は消える", async () => {
    await makePayment(PAYMENT_RETENTION_DAYS + 1);
    expect(await purgeOldPayments(db)).toBe(1);
  });
});
