import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { emailDeliveryLogs, listings, payments } from "~/db/schema/index.ts";
import { LISTING_FEE_JPY } from "~/domain/pricing";
import { ulid } from "~/domain/ulid";
import { CRON_HOURLY, runScheduledTasks } from "~/server/cron.server";
import type { Db } from "~/server/db.server";
import {
  countFailedWebhooks,
  findPaymentAnomalies,
  reconcilePayments,
} from "~/server/services/payment/reconcile-service.server";
import {
  closeTestDb,
  makeDraft,
  makeUser,
  resetDatabase,
  testEnv,
  testLogger,
} from "./helpers.ts";

/**
 * 決済と掲載の突き合わせ。
 *
 * ★今日直した3つの欠陥が再発したときに、これが鳴るかどうかを見る。★
 * どれも「決済は成立、ログは成功、掲載は出ていない」という、どちらの画面にも
 * エラーが出ない壊れ方だった。直したうえで、それでも起きたら人が気づける
 * ことを確かめる。
 */
let db: Db;
let userId: string;
const env = testEnv();

beforeEach(async () => {
  db = await resetDatabase();
  const user = await makeUser(db, "reconcile@example.test");
  userId = user.id;
});

afterAll(async () => {
  await closeTestDb();
});

/** 支払い済みの決済を作る。minutesAgo 分前に成立したことにする */
async function makePaidPayment(listingId: string, minutesAgo: number) {
  const paymentId = ulid();
  await db.insert(payments).values({
    id: paymentId,
    listingId,
    userId,
    provider: "stripe",
    checkoutSessionId: `cs_test_${paymentId}`,
    amountJpy: LISTING_FEE_JPY,
    currency: "jpy",
    status: "succeeded",
  });
  await db.execute(sql`
    update payments set paid_at = now() - make_interval(mins => ${minutesAgo})
    where id = ${paymentId}
  `);
  return paymentId;
}

/**
 * 未入金の決済を作る。minutesAgo 分前に Session を作ったことにする。
 *
 * ★created_at をずらすのは raw SQL で行う。★ drizzle の insert には
 * defaultNow() が効くので、値を渡しても列の既定に上書きされる。
 */
async function makeUnpaidPayment(
  listingId: string,
  options: {
    status: "created" | "pending" | "expired" | "failed";
    minutesAgo: number;
  },
) {
  const paymentId = ulid();
  await db.insert(payments).values({
    id: paymentId,
    listingId,
    userId,
    provider: "stripe",
    checkoutSessionId: `cs_test_${paymentId}`,
    amountJpy: LISTING_FEE_JPY,
    currency: "jpy",
    status: options.status,
  });
  await db.execute(sql`
    update payments set created_at = now() - make_interval(mins => ${options.minutesAgo})
    where id = ${paymentId}
  `);
  return paymentId;
}

describe("★払ったのに掲載が出ていないことを見つける★", () => {
  it("成立から1時間を過ぎて未公開なら見つける", async () => {
    const listingId = await makeDraft(db, userId, { status: "draft" });
    await makePaidPayment(listingId, 90);

    const found = await findPaymentAnomalies(db);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("paid_not_published");
    expect(found[0]!.listingId).toBe(listingId);
  });

  it("成立直後は見つけない（Webhook がまだ届いていないだけ）", async () => {
    const listingId = await makeDraft(db, userId, { status: "draft" });
    await makePaidPayment(listingId, 5);

    expect(await findPaymentAnomalies(db)).toHaveLength(0);
  });

  it("★公開後に本人が掲載終了したものは異常ではない★", async () => {
    /*
     * status だけを見ると closed は「公開されていない」と誤判定する。
     * 公開されたことがあるかは published_at で見る。ここを間違えると、
     * 正常に使い終わった投稿すべてで警報が鳴り、本物が埋もれる。
     */
    const listingId = await makeDraft(db, userId, { status: "closed" });
    await db
      .update(listings)
      .set({ publishedAt: new Date(Date.now() - 86400000) })
      .where(eq(listings.id, listingId));
    await makePaidPayment(listingId, 90);

    expect(await findPaymentAnomalies(db)).toHaveLength(0);
  });

  it("作りたての未払いは対象外（まだ決済の途中）", async () => {
    const listingId = await makeDraft(db, userId, { status: "draft" });
    await makeUnpaidPayment(listingId, { status: "created", minutesAgo: 0 });

    expect(await findPaymentAnomalies(db)).toHaveLength(0);
  });
});

/**
 * ★Webhook が1件も届かないことを見つける★
 *
 * 2026-08-29、preview のサンドボックスに送信先を作っていなかったため、
 * 決済しても投稿が payment_pending から動かなかった。
 * ★どの警報も鳴らなかった。★ 失敗した通知も、止まった通知も無い
 * ——通知が1件も無いのだから、行を数える検査には掛かりようがない。
 *
 * 本番で同じことが起きれば「お金は取られたが掲載は出ず、誰も気づかない」。
 */
describe("★Stripe からの通知が1件も届いていないことを見つける★", () => {
  it("Session の期限＋猶予を過ぎて created のままなら見つける", async () => {
    const listingId = await makeDraft(db, userId, { status: "payment_pending" });
    const paymentId = await makeUnpaidPayment(listingId, {
      status: "created",
      minutesAgo: 120, // 期限60分 + 猶予30分 を超えている
    });

    const found = await findPaymentAnomalies(db);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("webhook_never_arrived");
    expect(found[0]!.paymentId).toBe(paymentId);
  });

  it("★期限内なら見つけない（放置された決済は正常にありうる）★", async () => {
    // ここで鳴ると、買うのをやめた人のぶんだけ毎時メールが出る。
    const listingId = await makeDraft(db, userId, { status: "payment_pending" });
    await makeUnpaidPayment(listingId, { status: "created", minutesAgo: 45 });

    expect(await findPaymentAnomalies(db)).toHaveLength(0);
  });

  it("★expired なら異常ではない（失効の通知は届いている）★", async () => {
    /*
     * 判定の根拠がここ。Stripe は期限が来れば必ず expired を送る。
     * 受け取れていれば status は expired になる。created のままという
     * ことは、成立も失効も届いていないということ。
     */
    const listingId = await makeDraft(db, userId, { status: "draft" });
    await makeUnpaidPayment(listingId, { status: "expired", minutesAgo: 300 });

    expect(await findPaymentAnomalies(db)).toHaveLength(0);
  });

  it("★pending は対象外（後払いの入金待ちは数日かかる）★", async () => {
    // pending は「completed は届いたが入金がまだ」。通知の経路は生きている。
    const listingId = await makeDraft(db, userId, {
      status: "payment_processing",
    });
    await makeUnpaidPayment(listingId, { status: "pending", minutesAgo: 4320 });

    expect(await findPaymentAnomalies(db)).toHaveLength(0);
  });

  it("failed も対象外（失敗の通知は届いている）", async () => {
    const listingId = await makeDraft(db, userId, { status: "draft" });
    await makeUnpaidPayment(listingId, { status: "failed", minutesAgo: 300 });

    expect(await findPaymentAnomalies(db)).toHaveLength(0);
  });

  it("★投稿が消えていても見つける★", async () => {
    /*
     * 決済記録は退会しても残る（listing_id は ON DELETE SET NULL）。
     * inner join にすると、痕跡がいちばん残っていない決済だけが漏れる。
     */
    const listingId = await makeDraft(db, userId, { status: "payment_pending" });
    await makeUnpaidPayment(listingId, { status: "created", minutesAgo: 120 });
    // 退会処理が実際に行うこと（参照だけ外し、決済記録は残す）
    await db.execute(sql`update payments set listing_id = null`);

    const found = await findPaymentAnomalies(db);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("webhook_never_arrived");
    expect(found[0]!.listingId).toBeNull();
    // 件名に "undefined" や空欄が出ないこと
    expect(found[0]!.listingTitle).toContain("投稿は残っていません");
  });

  it("見つけたら運営者へメールが出る（1件につき1回）", async () => {
    const listingId = await makeDraft(db, userId, { status: "payment_pending" });
    await makeUnpaidPayment(listingId, { status: "created", minutesAgo: 120 });

    expect(await reconcilePayments({ db, env, logger: testLogger })).toBe(1);
    expect(await reconcilePayments({ db, env, logger: testLogger })).toBe(1);

    const sent = await db
      .select({ key: emailDeliveryLogs.idempotencyKey })
      .from(emailDeliveryLogs)
      .where(eq(emailDeliveryLogs.template, "ops_payment_alert"));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.key).toMatch(/^ops_payment_alert:webhook_never_arrived:/);
  });
});

describe("★返金したのに掲載が続いていることを見つける★", () => {
  it("全額返金済みで公開中なら見つける", async () => {
    const listingId = await makeDraft(db, userId, { status: "published" });
    await db
      .update(listings)
      .set({ publishedAt: new Date() })
      .where(eq(listings.id, listingId));
    const paymentId = await makePaidPayment(listingId, 120);
    await db
      .update(payments)
      .set({ status: "refunded", refundedAmountJpy: LISTING_FEE_JPY })
      .where(eq(payments.id, paymentId));

    const found = await findPaymentAnomalies(db);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("refunded_but_live");
  });

  it("返金後に停止済みなら異常ではない", async () => {
    const listingId = await makeDraft(db, userId, { status: "suspended" });
    await db
      .update(listings)
      .set({ publishedAt: new Date() })
      .where(eq(listings.id, listingId));
    const paymentId = await makePaidPayment(listingId, 120);
    await db
      .update(payments)
      .set({ status: "refunded", refundedAmountJpy: LISTING_FEE_JPY })
      .where(eq(payments.id, paymentId));

    expect(await findPaymentAnomalies(db)).toHaveLength(0);
  });
});

describe("警報の送りかた", () => {
  it("★1件につき1回だけ送る★", async () => {
    // 直すまで毎時鳴ると慣れて読まなくなり、見るべき日に見落とす。
    const listingId = await makeDraft(db, userId, { status: "draft" });
    await makePaidPayment(listingId, 90);

    expect(await reconcilePayments({ db, env, logger: testLogger })).toBe(1);
    expect(await reconcilePayments({ db, env, logger: testLogger })).toBe(1);
    expect(await reconcilePayments({ db, env, logger: testLogger })).toBe(1);

    const sent = await db
      .select({ id: emailDeliveryLogs.id })
      .from(emailDeliveryLogs)
      .where(eq(emailDeliveryLogs.template, "ops_payment_alert"));
    expect(sent).toHaveLength(1);
  });

  it("異常が無ければ何も送らない", async () => {
    expect(await reconcilePayments({ db, env, logger: testLogger })).toBe(0);

    const sent = await db
      .select({ id: emailDeliveryLogs.id })
      .from(emailDeliveryLogs)
      .where(eq(emailDeliveryLogs.template, "ops_payment_alert"));
    expect(sent).toHaveLength(0);
  });

  it("処理に失敗した Webhook の件数を数える", async () => {
    expect(await countFailedWebhooks(db)).toBe(0);
    await db.execute(sql`
      insert into payment_webhook_events
        (id, provider, event_id, event_type, payload_digest, status)
      values (${ulid()}, 'stripe', 'evt_fail', 'charge.refunded',
              ${"a".repeat(64)}, 'failed')
    `);
    expect(await countFailedWebhooks(db)).toBe(1);
  });

  it("★受け取ったまま止まっている Webhook も数える（15分を過ぎたもの）★", async () => {
    /*
     * 重複防止の行を先に作ってから処理する作りなので、処理の途中で Worker が
     * 落ちると received のまま残る。Stripe の再送は「重複」で素通りし、
     * 誰も処理しない。failed だけを見ていると、この形は警報に掛からない。
     */
    await db.execute(sql`
      insert into payment_webhook_events
        (id, provider, event_id, event_type, payload_digest, status, received_at)
      values
        (${ulid()}, 'stripe', 'evt_fresh', 'checkout.session.completed',
         ${"b".repeat(64)}, 'received', now() - interval '3 minutes'),
        (${ulid()}, 'stripe', 'evt_stuck', 'checkout.session.completed',
         ${"c".repeat(64)}, 'received', now() - interval '40 minutes')
    `);
    // 3分前のものは処理中かもしれないので数えない。40分前のは数える。
    expect(await countFailedWebhooks(db)).toBe(1);
  });

  it("★失敗した Webhook があれば運営者へメールが出る（1日1通）★", async () => {
    // 以前は件数をログに出すだけで、メールは投稿単位の異常にしか出ていなかった。
    await db.execute(sql`
      insert into payment_webhook_events
        (id, provider, event_id, event_type, payload_digest, status)
      values (${ulid()}, 'stripe', 'evt_fail2', 'checkout.session.completed',
              ${"d".repeat(64)}, 'failed')
    `);

    expect(await reconcilePayments({ db, env, logger: testLogger })).toBe(1);
    expect(await reconcilePayments({ db, env, logger: testLogger })).toBe(1);

    const sent = await db
      .select({ key: emailDeliveryLogs.idempotencyKey })
      .from(emailDeliveryLogs)
      .where(eq(emailDeliveryLogs.template, "ops_payment_alert"));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.key).toMatch(/^ops_payment_alert:failed_webhooks:\d{4}-\d{2}-\d{2}$/);
  });
});

describe("毎時の定期処理から呼ばれる", () => {
  it("★1時間ごとに突き合わせる（日次では遅い）★", async () => {
    const listingId = await makeDraft(db, userId, { status: "draft" });
    await makePaidPayment(listingId, 90);

    const result = await runScheduledTasks({
      cron: CRON_HOURLY,
      db,
      env,
      logger: testLogger,
    });

    expect(Object.keys(result).sort()).toEqual([
      "expireListings",
      "reconcilePayments",
    ]);
    expect(result.reconcilePayments).toBe(1);
  });
});
