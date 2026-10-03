import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  auditLogs,
  emailDeliveryLogs,
  listings,
  payments,
  paymentWebhookEvents,
} from "~/db/schema/index.ts";
import { LISTING_FEE_JPY } from "~/domain/pricing";
import { ulid } from "~/domain/ulid";
import type { Db } from "~/server/db.server";
import { AppError } from "~/server/errors";
import { transitionListing } from "~/server/services/listing-service.server";
import {
  cancelOpenCheckouts,
  getPaymentStateForListing,
  handleStripeEvent,
  refundPayment,
  startListingCheckout,
} from "~/server/services/payment/payment-service.server";
import { findPaymentAnomalies } from "~/server/services/payment/reconcile-service.server";
import type { StripeEvent } from "~/server/services/payment/stripe-client.server";
import { closeTestDb, makeDraft, makeUser, resetDatabase, testEnv, testLogger } from "./helpers.ts";

/**
 * 決済の経路（2026-10 の監査 PAY-01・PAY-03・PAY-04・PAY-05・AUTHZ-01・FN-07・PAY-02 ほか）。
 *
 * ★Stripe は fetch の差し替えで演じる。外へは出ない。★
 * Session の状態は Stripe の API リファレンスどおり open / complete / expired の3つ。
 * /expire できるのは open だけで、それ以外は 400 を返す。
 */
let db: Db;
const env = testEnv();
let userId: string;

type SessionState = "open" | "complete" | "expired";
const sessions = new Map<string, SessionState>();
/** Stripe に存在しない Session（404 resource_missing を返す） */
const missingSessions = new Set<string>();
let created = 0;
let retrieveFails = false;
let refundStatus = "succeeded";
/** 次の /expire の直前に、この Session を complete にする（支払いとの行き違いを演じる） */
let completeBeforeExpire: string | null = null;
const realFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  db = await resetDatabase();
  userId = (await makeUser(db, "payer-flow@example.test")).id;
  sessions.clear();
  missingSessions.clear();
  created = 0;
  retrieveFails = false;
  refundStatus = "succeeded";
  completeBeforeExpire = null;

  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.replace("https://api.stripe.com/v1", "");

    const expire = /^\/checkout\/sessions\/([^/]+)\/expire$/.exec(path);
    if (expire && method === "POST") {
      const id = decodeURIComponent(expire[1]!);
      if (completeBeforeExpire === id) {
        sessions.set(id, "complete");
        completeBeforeExpire = null;
      }
      if (sessions.get(id) !== "open") {
        return Promise.resolve(
          json({ error: { type: "invalid_request_error", message: "not open" } }, 400),
        );
      }
      sessions.set(id, "expired");
      return Promise.resolve(json({ id, status: "expired", payment_status: "unpaid", url: null }));
    }

    const one = /^\/checkout\/sessions\/([^/]+)$/.exec(path);
    if (one && method === "GET") {
      if (retrieveFails) {
        return Promise.resolve(json({ error: { type: "api_error", message: "down" } }, 500));
      }
      const id = decodeURIComponent(one[1]!);
      if (missingSessions.has(id)) {
        return Promise.resolve(
          json(
            { error: { type: "invalid_request_error", code: "resource_missing", message: "No such checkout.session" } },
            404,
          ),
        );
      }
      const status = sessions.get(id) ?? "expired";
      return Promise.resolve(
        json({ id, status, payment_status: status === "complete" ? "paid" : "unpaid", url: null }),
      );
    }

    if (path === "/checkout/sessions" && method === "POST") {
      created += 1;
      const id = `cs_test_flow_${created}`;
      sessions.set(id, "open");
      return Promise.resolve(
        json({ id, url: `https://checkout.stripe.com/c/pay/${id}`, status: "open", payment_status: "unpaid" }),
      );
    }

    if (path === "/refunds" && method === "POST") {
      return Promise.resolve(
        json({ id: "re_test_flow", amount: LISTING_FEE_JPY, status: refundStatus, charge: null, payment_intent: "pi_x" }),
      );
    }

    return Promise.reject(new Error(`unexpected stripe call: ${method} ${path}`));
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  await closeTestDb();
});

function start(listingId: string) {
  return startListingCheckout({
    db,
    env,
    logger: testLogger,
    request: new Request("https://example.test/checkout", { method: "POST" }),
    listingId,
    userId,
  });
}

function paidEvent(sessionId: string, listingId: string, eventId: string): StripeEvent {
  return {
    id: eventId,
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: sessionId,
        payment_status: "paid",
        amount_total: LISTING_FEE_JPY,
        currency: "jpy",
        payment_intent: `pi_${sessionId}`,
        metadata: { listing_id: listingId, user_id: userId, duration_days: "30" },
      },
    },
  };
}

async function deliver(event: StripeEvent) {
  return handleStripeEvent({ db, env, logger: testLogger, event, rawPayload: JSON.stringify(event) });
}

async function paymentStatus(id: string) {
  const rows = await db.select({ status: payments.status }).from(payments).where(eq(payments.id, id));
  return rows[0]?.status;
}

/** 利用者への «お支払いを確認できませんでした» の送信記録の件数 */
async function failedMails() {
  const rows = await db
    .select({ id: emailDeliveryLogs.id })
    .from(emailDeliveryLogs)
    .where(eq(emailDeliveryLogs.template, "payment_failed"));
  return rows.length;
}

async function listingStatus(id: string) {
  const rows = await db.select({ status: listings.status }).from(listings).where(eq(listings.id, id));
  return rows[0]?.status;
}

async function expectAppError(promise: Promise<unknown>, code: string, messagePart: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  expect((error as AppError).message).toContain(messagePart);
}

describe("払い終わった後にもう一度 «支払う» を押す（PAY-01）", () => {
  it("新しい支払いリンクを作らずに «確認中» で止め、届いた成立の通知で公開する", async () => {
    const listingId = await makeDraft(db, userId);
    const first = await start(listingId);
    sessions.set("cs_test_flow_1", "complete"); // 利用者が1本目を払った。通知はまだ

    await expectAppError(start(listingId), "conflict", "お支払いの確認中です");
    expect(created).toBe(1); // 2本目の Session は作られていない
    expect(await paymentStatus(first.paymentId)).toBe("created"); // expired にしない

    const result = await deliver(paidEvent("cs_test_flow_1", listingId, "evt_flow_paid_1"));
    expect(result.status).toBe("processed");
    expect(await listingStatus(listingId)).toBe("published");
    expect(await paymentStatus(first.paymentId)).toBe("succeeded");
  });

  it("★二重の守り★ 記録が expired になっていても、成立の通知が来れば公開する（以前の版が残した行）", async () => {
    const listingId = await makeDraft(db, userId);
    const first = await start(listingId);
    await db.update(payments).set({ status: "expired" }).where(eq(payments.id, first.paymentId));

    const result = await deliver(paidEvent("cs_test_flow_1", listingId, "evt_flow_paid_legacy"));
    expect(result.status).toBe("processed");
    expect(await listingStatus(listingId)).toBe("published");
    expect(await paymentStatus(first.paymentId)).toBe("succeeded");
  });

  it("前回がまだ進行中なら、今までどおり失効させて新しいリンクを出す", async () => {
    const listingId = await makeDraft(db, userId);
    const first = await start(listingId);
    const second = await start(listingId);
    expect(second.paymentId).not.toBe(first.paymentId);
    expect(created).toBe(2);
    expect(sessions.get("cs_test_flow_1")).toBe("expired");
    expect(await paymentStatus(first.paymentId)).toBe("expired");
    expect(await paymentStatus(second.paymentId)).toBe("created");
  });

  it("失効させる直前に払い終わった（行き違い）なら、新しい方を使わせず «確認中» で止める", async () => {
    const listingId = await makeDraft(db, userId);
    const first = await start(listingId);
    completeBeforeExpire = "cs_test_flow_1";

    await expectAppError(start(listingId), "conflict", "お支払いの確認中です");
    expect(created).toBe(2); // 作ってしまった2本目は
    expect(sessions.get("cs_test_flow_2")).toBe("expired"); // Stripe 側で失効させ
    const rows = await db.select({ id: payments.id, status: payments.status }).from(payments).where(eq(payments.listingId, listingId));
    const second = rows.find((r) => r.id !== first.paymentId);
    expect(second?.status).toBe("expired"); // 記録も失効
    expect(await paymentStatus(first.paymentId)).toBe("created"); // 払われた1本目はそのまま
  });

  it("行き違いでこちらが閉じた2本目の失効通知が来ても、投稿は決済待ちのまま・失敗メールは出ない", async () => {
    const listingId = await makeDraft(db, userId);
    await start(listingId);
    completeBeforeExpire = "cs_test_flow_1";
    await expectAppError(start(listingId), "conflict", "お支払いの確認中です");

    // こちらが /expire した2本目の失効通知（Stripe は直後に送ってくる）
    const result = await deliver({
      id: "evt_flow_expired_2",
      type: "checkout.session.expired",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "cs_test_flow_2" } },
    });
    expect(result.status).toBe("processed");
    expect(await listingStatus(listingId)).toBe("payment_pending");
    expect(await failedMails()).toBe(0);
    // 確認中の画面は «いちばん進んだ» 決済（払われた1本目）を見る
    expect((await getPaymentStateForListing(db, listingId))?.status).toBe("created");
  });

  it("Stripe に無い Session（404 resource_missing）は «切れている» として、新しいリンクを出す", async () => {
    const listingId = await makeDraft(db, userId);
    const first = await start(listingId);
    sessions.delete("cs_test_flow_1");
    missingSessions.add("cs_test_flow_1");
    const second = await start(listingId);
    expect(second.paymentId).not.toBe(first.paymentId);
    expect(await paymentStatus(first.paymentId)).toBe("expired");
  });

  it("★Stripe に状態を聞けなければ、新しいリンクを作らない（fail-closed）★", async () => {
    const listingId = await makeDraft(db, userId);
    await start(listingId);
    retrieveFails = true;
    await expectAppError(start(listingId), "payment_failed", "決済の状態を確認できませんでした");
    expect(created).toBe(1);
  });
});

describe("決済待ちの投稿を消す・却下する（FN-07・ADM-15）", () => {
  it("進行中の支払いリンクを失効させ、記録も expired にする", async () => {
    const listingId = await makeDraft(db, userId);
    const first = await start(listingId);
    const result = await cancelOpenCheckouts({ db, env, logger: testLogger, listingId });
    expect(result.paidInProgress).toBe(false);
    expect(sessions.get("cs_test_flow_1")).toBe("expired");
    expect(await paymentStatus(first.paymentId)).toBe("expired");
  });

  it("払い終わったリンクがあれば paidInProgress を返し、記録には触らない", async () => {
    const listingId = await makeDraft(db, userId);
    const first = await start(listingId);
    sessions.set("cs_test_flow_1", "complete");
    const result = await cancelOpenCheckouts({ db, env, logger: testLogger, listingId });
    expect(result.paidInProgress).toBe(true);
    expect(await paymentStatus(first.paymentId)).toBe("created");
  });

  it("失効させた後に届く失効通知では、投稿を下書きへ戻さず、失敗メールも出さない", async () => {
    const listingId = await makeDraft(db, userId);
    await start(listingId);
    await cancelOpenCheckouts({ db, env, logger: testLogger, listingId });
    await transitionListing(db, { listingId, to: "deleted", actor: "owner" });
    await deliver({
      id: "evt_flow_expired_after_cancel",
      type: "checkout.session.expired",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "cs_test_flow_1" } },
    });
    expect(await listingStatus(listingId)).toBe("deleted");
    expect(await failedMails()).toBe(0);
  });

  it("失効させる直前に払い終わったら、もう一度 «削除» を押しても止まり続ける", async () => {
    const listingId = await makeDraft(db, userId);
    const first = await start(listingId);
    completeBeforeExpire = "cs_test_flow_1";
    const once = await cancelOpenCheckouts({ db, env, logger: testLogger, listingId });
    expect(once.paidInProgress).toBe(true);
    expect(await paymentStatus(first.paymentId)).toBe("created"); // 記録は元に戻っている
    const twice = await cancelOpenCheckouts({ db, env, logger: testLogger, listingId });
    expect(twice.paidInProgress).toBe(true);
  });

  it("Stripe に聞けなければ、払われているかもしれないものとして扱う", async () => {
    const listingId = await makeDraft(db, userId);
    await start(listingId);
    retrieveFails = true;
    const result = await cancelOpenCheckouts({ db, env, logger: testLogger, listingId });
    expect(result.paidInProgress).toBe(true);
  });
});

describe("投稿の参照が外れた決済の返金・係争も帳簿に残す（PAY-03）", () => {
  async function detachedPayment(status: "succeeded" | "refunded" = "succeeded") {
    const listingId = await makeDraft(db, userId, { status: "closed", publishedAt: new Date() });
    const id = ulid();
    await db.insert(payments).values({
      id,
      listingId,
      userId,
      provider: "stripe",
      checkoutSessionId: `cs_detached_${id}`,
      paymentIntentId: `pi_detached_${id}`,
      amountJpy: LISTING_FEE_JPY,
      currency: "jpy",
      status,
    });
    // 退会・180日の削除と同じく参照を外す（FK は SET NULL）
    await db.update(payments).set({ listingId: null, userId: null }).where(eq(payments.id, id));
    return id;
  }

  it("全額返金の通知で refunded になり、決済を対象に監査ログが残る", async () => {
    const id = await detachedPayment();
    const result = await deliver({
      id: "evt_detached_refund",
      type: "charge.refunded",
      created: Math.floor(Date.now() / 1000),
      data: { object: { payment_intent: `pi_detached_${id}`, amount_refunded: LISTING_FEE_JPY } },
    });
    expect(result.status).toBe("processed");
    expect(await paymentStatus(id)).toBe("refunded");
    const logs = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "payment.refunded"), eq(auditLogs.targetId, id)));
    expect(logs).toHaveLength(1);
  });

  it("係争の通知で disputed になる", async () => {
    const id = await detachedPayment();
    const result = await deliver({
      id: "evt_detached_dispute",
      type: "charge.dispute.created",
      created: Math.floor(Date.now() / 1000),
      data: { object: { payment_intent: `pi_detached_${id}` } },
    });
    expect(result.status).toBe("processed");
    expect(await paymentStatus(id)).toBe("disputed");
  });

  it("返金の後に係争が来ても、返金の記録を上書きしない（B-01）", async () => {
    const id = await detachedPayment("refunded");
    await deliver({
      id: "evt_detached_dispute_after_refund",
      type: "charge.dispute.created",
      created: Math.floor(Date.now() / 1000),
      data: { object: { payment_intent: `pi_detached_${id}` } },
    });
    expect(await paymentStatus(id)).toBe("refunded");
  });
});

describe("成立済みの決済を «確認中» に戻さない（PAY-04）", () => {
  it("succeeded の後に未入金の completed が後着しても succeeded のまま", async () => {
    const listingId = await makeDraft(db, userId);
    const first = await start(listingId);
    await deliver(paidEvent("cs_test_flow_1", listingId, "evt_paid_first"));
    expect(await paymentStatus(first.paymentId)).toBe("succeeded");

    const late = paidEvent("cs_test_flow_1", listingId, "evt_unpaid_late");
    late.data.object.payment_status = "unpaid";
    await deliver(late);
    expect(await paymentStatus(first.paymentId)).toBe("succeeded");
    expect(await listingStatus(listingId)).toBe("published");
  });
});

describe("失敗した通知の再送（運用手順が効くこと）", () => {
  it("failed の通知は、同じ event id で再送されると処理し直される。処理済みは飛ばす", async () => {
    const listingId = await makeDraft(db, userId);
    const first = await start(listingId);
    // 1回目: 決済の記録を一時的に外して落とす（DB の一時障害の代わり）
    await db.update(payments).set({ checkoutSessionId: "cs_hidden" }).where(eq(payments.id, first.paymentId));
    const failed = await deliver(paidEvent("cs_test_flow_1", listingId, "evt_resend_1"));
    expect(failed.status).toBe("failed");
    // 原因を直して、Stripe のダッシュボードから同じ通知を再送
    await db.update(payments).set({ checkoutSessionId: "cs_test_flow_1" }).where(eq(payments.id, first.paymentId));
    const retried = await deliver(paidEvent("cs_test_flow_1", listingId, "evt_resend_1"));
    expect(retried.status).toBe("processed");
    expect(await listingStatus(listingId)).toBe("published");
    // もう一度届いても、処理済みなので飛ばす
    const again = await deliver(paidEvent("cs_test_flow_1", listingId, "evt_resend_1"));
    expect(again.status).toBe("duplicate");
  });
});

describe("Webhook の記録に決済と投稿を書く（MON-03）", () => {
  it("処理した通知に payment_id と listing_id が入る", async () => {
    const listingId = await makeDraft(db, userId);
    const first = await start(listingId);
    await deliver(paidEvent("cs_test_flow_1", listingId, "evt_link_1"));
    const rows = await db
      .select({ paymentId: paymentWebhookEvents.paymentId, listingId: paymentWebhookEvents.listingId })
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.eventId, "evt_link_1"));
    expect(rows[0]).toEqual({ paymentId: first.paymentId, listingId });
  });
});

describe("管理者は支払いの無い投稿を公開できない（AUTHZ-01）", () => {
  it("決済待ちから却下した投稿を «公開に戻す» と止まる", async () => {
    const listingId = await makeDraft(db, userId, { status: "payment_pending" });
    await transitionListing(db, { listingId, to: "rejected", actor: "admin" });
    await expectAppError(
      transitionListing(db, { listingId, to: "published", actor: "admin" }),
      "conflict",
      "お支払いが確認できない投稿",
    );
    expect(await listingStatus(listingId)).toBe("rejected");
  });

  it("支払いが成立していれば戻せる（払った後に却下した投稿）", async () => {
    const listingId = await makeDraft(db, userId, { status: "payment_pending" });
    await db.insert(payments).values({
      id: ulid(),
      listingId,
      userId,
      provider: "stripe",
      checkoutSessionId: "cs_paid_then_rejected",
      amountJpy: LISTING_FEE_JPY,
      currency: "jpy",
      status: "succeeded",
    });
    await transitionListing(db, { listingId, to: "rejected", actor: "admin" });
    const result = await transitionListing(db, { listingId, to: "published", actor: "admin" });
    expect(result.changed).toBe(true);
  });
});

describe("突き合わせの新しい種類（PAY-02・PAY-01 の網・AUTHZ-01 の網）", () => {
  it("同じ投稿に成立が2本あれば duplicate_paid", async () => {
    const listingId = await makeDraft(db, userId, { status: "published", publishedAt: new Date() });
    for (const n of [1, 2]) {
      await db.insert(payments).values({
        id: ulid(),
        listingId,
        userId,
        provider: "stripe",
        checkoutSessionId: `cs_dup_${n}`,
        amountJpy: LISTING_FEE_JPY,
        currency: "jpy",
        status: "succeeded",
        paidAt: new Date(),
      });
    }
    const kinds = (await findPaymentAnomalies(db)).map((a) => a.kind);
    expect(kinds.filter((k) => k === "duplicate_paid")).toHaveLength(1);
  });

  it("二重払いの片方を返金しても掲載は止めず、返金済みなのに公開中の警報も出さない", async () => {
    const listingId = await makeDraft(db, userId, { status: "published", publishedAt: new Date() });
    const ids: string[] = [];
    for (const n of [1, 2]) {
      const id = ulid();
      ids.push(id);
      await db.insert(payments).values({
        id,
        listingId,
        userId,
        provider: "stripe",
        checkoutSessionId: `cs_dup_refund_${n}`,
        paymentIntentId: `pi_dup_refund_${n}`,
        amountJpy: LISTING_FEE_JPY,
        currency: "jpy",
        status: "succeeded",
        paidAt: new Date(),
      });
    }
    await deliver({
      id: "evt_dup_refund",
      type: "charge.refunded",
      created: Math.floor(Date.now() / 1000),
      data: { object: { payment_intent: "pi_dup_refund_2", amount_refunded: LISTING_FEE_JPY } },
    });
    expect(await paymentStatus(ids[1]!)).toBe("refunded");
    expect(await listingStatus(listingId)).toBe("published");
    const kinds = (await findPaymentAnomalies(db)).map((a) => a.kind);
    expect(kinds).not.toContain("refunded_but_live");
    expect(kinds).not.toContain("duplicate_paid");
  });

  it("成立の通知が failed で決済が成立していなければ paid_webhook_failed", async () => {
    const listingId = await makeDraft(db, userId, { status: "payment_pending" });
    const id = ulid();
    await db.insert(payments).values({
      id,
      listingId,
      userId,
      provider: "stripe",
      checkoutSessionId: "cs_failed_hook",
      amountJpy: LISTING_FEE_JPY,
      currency: "jpy",
      status: "expired",
    });
    await db.insert(paymentWebhookEvents).values({
      id: ulid(),
      provider: "stripe",
      eventId: "evt_failed_hook",
      eventType: "checkout.session.completed",
      payloadDigest: "0".repeat(64),
      status: "failed",
      paymentId: id,
      listingId,
    });
    const kinds = (await findPaymentAnomalies(db)).map((a) => a.kind);
    expect(kinds).toContain("paid_webhook_failed");
  });

  it("支払いの成立が一度も無いのに公開されたことがあれば published_without_payment", async () => {
    await makeDraft(db, userId, { status: "published", publishedAt: new Date() });
    const kinds = (await findPaymentAnomalies(db)).map((a) => a.kind);
    expect(kinds).toContain("published_without_payment");
  });
});

describe("返金が Stripe 側で失敗したら知らせる（PAY-05）", () => {
  it("refund の status が failed なら payment_failed で止める", async () => {
    const listingId = await makeDraft(db, userId, { status: "published", publishedAt: new Date() });
    const id = ulid();
    await db.insert(payments).values({
      id,
      listingId,
      userId,
      provider: "stripe",
      checkoutSessionId: "cs_refund_fail",
      paymentIntentId: "pi_refund_fail",
      amountJpy: LISTING_FEE_JPY,
      currency: "jpy",
      status: "succeeded",
    });
    for (const status of ["failed", "canceled"]) {
      refundStatus = status;
      await expectAppError(
        refundPayment({ db, env, logger: testLogger, paymentId: id, adminId: userId }),
        "payment_failed",
        "返金が完了しませんでした",
      );
    }
  });
});
