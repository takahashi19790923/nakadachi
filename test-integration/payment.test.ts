import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  auditLogs,
  listings,
  payments,
  paymentWebhookEvents,
} from "~/db/schema/index.ts";
import { LISTING_FEE_JPY } from "~/domain/pricing";
import { ulid } from "~/domain/ulid";
import type { Db } from "~/server/db.server";
import {
  handleStripeEvent,
  startListingCheckout,
} from "~/server/services/payment/payment-service.server";
import type { StripeEvent } from "~/server/services/payment/stripe-client.server";
import {
  closeTestDb,
  makeDraft,
  makeUser,
  resetDatabase,
  testEnv,
  testLogger,
} from "./helpers.ts";

/**
 * 決済 Webhook。
 *
 * ★署名検証は単体テスト（test/stripe-signature.test.ts）で見ている。★
 * ここでは「検証を通ったあと、DB がどう変わるか」だけを見る。
 */
let db: Db;
const env = testEnv();

let userId: string;
let listingId: string;
let paymentId: string;
const sessionId = "cs_test_integration_1";

beforeEach(async () => {
  db = await resetDatabase();
  const user = await makeUser(db, "payer@example.test");
  userId = user.id;
  listingId = await makeDraft(db, userId, { status: "payment_pending" });
  paymentId = ulid();

  await db.insert(payments).values({
    id: paymentId,
    listingId,
    userId,
    provider: "stripe",
    checkoutSessionId: sessionId,
    amountJpy: LISTING_FEE_JPY,
    currency: "jpy",
    status: "created",
  });
});

afterAll(async () => {
  await closeTestDb();
});

function completedEvent(overrides: {
  id?: string;
  amountTotal?: number | null;
  currency?: string;
  listingId?: string;
  userId?: string;
  paymentStatus?: string;
  durationDays?: string;
}): StripeEvent {
  return {
    id: overrides.id ?? "evt_test_1",
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: sessionId,
        payment_status: overrides.paymentStatus ?? "paid",
        amount_total: overrides.amountTotal ?? LISTING_FEE_JPY,
        currency: overrides.currency ?? "jpy",
        payment_intent: "pi_test_1",
        metadata: {
          listing_id: overrides.listingId ?? listingId,
          user_id: overrides.userId ?? userId,
          payment_id: paymentId,
          duration_days: overrides.durationDays ?? "30",
        },
      },
    },
  };
}

async function statusOf(id: string): Promise<string> {
  const rows = await db
    .select({ status: listings.status })
    .from(listings)
    .where(eq(listings.id, id))
    .limit(1);
  return rows[0]!.status;
}

async function paymentStatus(): Promise<string> {
  const rows = await db
    .select({ status: payments.status })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);
  return rows[0]!.status;
}

describe("正常な決済", () => {
  it("★110円の支払い確認後にだけ公開される★", async () => {
    expect(await statusOf(listingId)).toBe("payment_pending");

    const result = await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: completedEvent({}),
      rawPayload: "{}",
    });

    expect(result.status).toBe("processed");
    expect(await statusOf(listingId)).toBe("published");
    expect(await paymentStatus()).toBe("succeeded");
  });

  it("公開時に掲載期限が設定される", async () => {
    await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: completedEvent({}),
      rawPayload: "{}",
    });

    const rows = await db
      .select({ publishedAt: listings.publishedAt, expiresAt: listings.expiresAt })
      .from(listings)
      .where(eq(listings.id, listingId))
      .limit(1);
    expect(rows[0]!.publishedAt).not.toBeNull();
    expect(rows[0]!.expiresAt).not.toBeNull();
  });

  it("★掲載期間は投稿に保存した日数で決まる（決済の metadata ではない）★", async () => {
    /*
     * 以前は Checkout の metadata.duration_days をそのまま使っていた。
     * 確認画面のフォームを書き換えれば 110円で 36500日（100年）にできたし、
     * 0 を送れば公開した瞬間に期限切れになった。行の値だけを見る。
     */
    await db
      .update(listings)
      .set({ durationDays: 90 })
      .where(eq(listings.id, listingId));

    await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: completedEvent({ durationDays: "36500" }),
      rawPayload: "{}",
    });

    const rows = await db
      .select({ publishedAt: listings.publishedAt, expiresAt: listings.expiresAt })
      .from(listings)
      .where(eq(listings.id, listingId))
      .limit(1);
    const days =
      (rows[0]!.expiresAt!.getTime() - rows[0]!.publishedAt!.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
  });
});

describe("★同じ Webhook を二度処理しない★", () => {
  it("2回目は duplicate になり、状態も変わらない", async () => {
    const event = completedEvent({ id: "evt_dup" });

    const first = await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event,
      rawPayload: "{}",
    });
    expect(first.status).toBe("processed");

    const second = await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event,
      rawPayload: "{}",
    });
    expect(second.status).toBe("duplicate");

    // イベントの記録は1件だけ
    const rows = await db
      .select({ id: paymentWebhookEvents.id })
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.eventId, "evt_dup"));
    expect(rows).toHaveLength(1);
  });

  it("同時に2通届いても片方しか成立しない", async () => {
    const event = completedEvent({ id: "evt_race" });

    const [a, b] = await Promise.all([
      handleStripeEvent({ db, env, logger: testLogger, event, rawPayload: "{}" }),
      handleStripeEvent({ db, env, logger: testLogger, event, rawPayload: "{}" }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["duplicate", "processed"]);
    expect(await statusOf(listingId)).toBe("published");
  });
});

describe("★110円以外の決済結果で公開されない★", () => {
  it("金額が違えば公開しない", async () => {
    const result = await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: completedEvent({ id: "evt_amount", amountTotal: 1 }),
      rawPayload: "{}",
    });

    expect(result.status).toBe("failed");
    expect(await statusOf(listingId)).toBe("payment_pending");
    expect(await paymentStatus()).toBe("failed");
  });

  it("通貨が違えば公開しない", async () => {
    const result = await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: completedEvent({ id: "evt_currency", currency: "usd" }),
      rawPayload: "{}",
    });

    expect(result.status).toBe("failed");
    expect(await statusOf(listingId)).toBe("payment_pending");
  });

  it("★metadata の投稿IDが決済記録と食い違えば公開しない★", async () => {
    const otherListing = await makeDraft(db, userId);
    const result = await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: completedEvent({ id: "evt_meta", listingId: otherListing }),
      rawPayload: "{}",
    });

    expect(result.status).toBe("failed");
    expect(await statusOf(listingId)).toBe("payment_pending");
    expect(await statusOf(otherListing)).toBe("draft");
  });

  it("★metadata の利用者IDが食い違えば公開しない★", async () => {
    const other = await makeUser(db, "other-payer@example.test");
    const result = await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: completedEvent({ id: "evt_user", userId: other.id }),
      rawPayload: "{}",
    });

    expect(result.status).toBe("failed");
    expect(await statusOf(listingId)).toBe("payment_pending");
  });

  it("未入金（後払い）の completed では公開せず、確認中にする", async () => {
    await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: completedEvent({ id: "evt_unpaid", paymentStatus: "unpaid" }),
      rawPayload: "{}",
    });

    expect(await statusOf(listingId)).toBe("payment_processing");
    expect(await paymentStatus()).toBe("pending");
  });
});

describe("決済の失敗と失効", () => {
  it("失効すると下書きへ戻る（再課金は発生しない）", async () => {
    await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: {
        id: "evt_expired",
        type: "checkout.session.expired",
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: sessionId } },
      },
      rawPayload: "{}",
    });

    expect(await statusOf(listingId)).toBe("draft");
    expect(await paymentStatus()).toBe("expired");
  });

  it("支払い済みの Session への失効通知は無視する", async () => {
    await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: completedEvent({ id: "evt_ok" }),
      rawPayload: "{}",
    });
    await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: {
        id: "evt_late_expiry",
        type: "checkout.session.expired",
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: sessionId } },
      },
      rawPayload: "{}",
    });

    expect(await statusOf(listingId)).toBe("published");
    expect(await paymentStatus()).toBe("succeeded");
  });
});

describe("★返金したら掲載を止める★", () => {
  beforeEach(async () => {
    await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: completedEvent({ id: "evt_before_refund" }),
      rawPayload: "{}",
    });
  });

  it("全額返金で非公開になる", async () => {
    await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: {
        id: "evt_refund",
        type: "charge.refunded",
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            payment_intent: "pi_test_1",
            amount_refunded: LISTING_FEE_JPY,
          },
        },
      },
      rawPayload: "{}",
    });

    expect(await statusOf(listingId)).toBe("suspended");
    expect(await paymentStatus()).toBe("refunded");
  });

  it("一部返金では止めない（手数料相当だけ返す運用で締め出さない）", async () => {
    await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: {
        id: "evt_partial",
        type: "refund.created",
        created: Math.floor(Date.now() / 1000),
        data: { object: { payment_intent: "pi_test_1", amount: 50 } },
      },
      rawPayload: "{}",
    });

    expect(await statusOf(listingId)).toBe("published");
    expect(await paymentStatus()).toBe("partially_refunded");
  });

  it("★同じ返金で複数のイベントが来ても二重に処理しない★", async () => {
    for (const [id, type] of [
      ["evt_r1", "charge.refunded"],
      ["evt_r2", "refund.created"],
      ["evt_r3", "refund.updated"],
    ] as const) {
      await handleStripeEvent({
        db,
        env,
        logger: testLogger,
        event: {
          id,
          type,
          created: Math.floor(Date.now() / 1000),
          data: {
            object: { payment_intent: "pi_test_1", amount_refunded: LISTING_FEE_JPY },
          },
        },
        rawPayload: "{}",
      });
    }

    expect(await statusOf(listingId)).toBe("suspended");
    expect(await paymentStatus()).toBe("refunded");
  });

  it("チャージバックは金額に関わらず止める", async () => {
    await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: {
        id: "evt_dispute",
        type: "charge.dispute.created",
        created: Math.floor(Date.now() / 1000),
        data: { object: { payment_intent: "pi_test_1", amount: 1 } },
      },
      rawPayload: "{}",
    });

    expect(await statusOf(listingId)).toBe("suspended");
    expect(await paymentStatus()).toBe("disputed");
  });
});

describe("知らないイベント", () => {
  it("記録だけして無視する", async () => {
    const result = await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: {
        id: "evt_unknown",
        type: "customer.created",
        created: Math.floor(Date.now() / 1000),
        data: { object: {} },
      },
      rawPayload: "{}",
    });
    expect(result.status).toBe("ignored");
  });

  it("★本文そのものを保存しない（ダイジェストだけ）★", async () => {
    await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: completedEvent({ id: "evt_digest" }),
      rawPayload: '{"customer_email":"secret@example.test"}',
    });

    const rows = await db
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.eventId, "evt_digest"))
      .limit(1);
    const row = rows[0]!;
    expect(row.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("secret@example.test");
  });
});

/**
 * 決済のやり直し。
 *
 * ★Stripe への呼び出しだけ差し替える。★ DB は本物を使う。ここで見たいのは
 * 「どの状態から何回押しても払える」ことと、そのとき生きた決済リンクが
 * 1本だけになることで、どちらも DB の中身でしか確かめられない。
 */
describe("★決済をやめて戻ってきた人がもう一度払える★", () => {
  let calls: { path: string; method: string }[] = [];
  let sessionSeq = 0;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    calls = [];
    sessionSeq = 0;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });

    globalThis.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const path = url.replace("https://api.stripe.com/v1", "");
      calls.push({ path, method: init?.method ?? "GET" });

      if (path.endsWith("/expire")) {
        return Promise.resolve(json({ id: "cs_expired", status: "expired" }));
      }
      sessionSeq += 1;
      return Promise.resolve(
        json({
          id: `cs_test_retry_${sessionSeq}`,
          url: `https://checkout.stripe.com/c/pay/cs_test_retry_${sessionSeq}`,
          payment_status: "unpaid",
          status: "open",
        }),
      );
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function start(id: string) {
    return startListingCheckout({
      db,
      env,
      logger: testLogger,
      request: new Request("https://example.test/checkout", { method: "POST" }),
      listingId: id,
      userId,
    });
  }

  it("payment_pending から押しても失敗しない", async () => {
    // ★これが本題。★ 以前は遷移表に payment_pending → payment_pending が
    // 無いため、2回目のボタンが必ず失敗した。しかも Stripe の Session と
    // payments 行を作った後で落ちるので、押すたびに捨て子が増えていた。
    const draftId = await makeDraft(db, userId, { status: "draft" });

    const first = await start(draftId);
    expect(first.redirectUrl).toContain("checkout.stripe.com");
    expect(await statusOf(draftId)).toBe("payment_pending");

    const second = await start(draftId);
    expect(second.redirectUrl).toContain("checkout.stripe.com");
    expect(await statusOf(draftId)).toBe("payment_pending");
    expect(second.paymentId).not.toBe(first.paymentId);
  });

  it("★生きた決済リンクは常に1本だけ★", async () => {
    // 2本残ると、両方の URL で払えて二重課金になる。返金しても
    // 利用者の明細には2回残るし、こちらのエラーには一切出ない。
    const draftId = await makeDraft(db, userId, { status: "draft" });

    const first = await start(draftId);
    await start(draftId);

    const rows = await db
      .select({ id: payments.id, status: payments.status })
      .from(payments)
      .where(eq(payments.listingId, draftId));

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === first.paymentId)?.status).toBe("expired");
    expect(rows.filter((r) => r.status === "created")).toHaveLength(1);

    // 古い Session を Stripe 側でも無効にしていること。
    expect(calls.some((c) => c.path.endsWith("/expire"))).toBe(true);

    /*
     * ★無効化は、新しい Session を作ったあとに呼ぶこと。★
     * /expire を呼ぶと Stripe は checkout.session.expired をただちに
     * 送り返してくる（実測220ms）。先に呼ぶと、その通知が新しい決済記録より
     * 早く着き、いま払おうとしている投稿が下書きへ戻る。
     * 払っている本人に「お支払いを確認できませんでした」が届く。
     */
    const firstExpire = calls.findIndex((c) => c.path.endsWith("/expire"));
    const lastCreate = calls
      .map((c, i) => (c.path === "/checkout/sessions" ? i : -1))
      .filter((i) => i >= 0)
      .pop();
    expect(lastCreate).toBeGreaterThan(-1);
    expect(firstExpire).toBeGreaterThan(lastCreate!);
  });

  it("支払い済みなら二度と課金しない", async () => {
    const draftId = await makeDraft(db, userId, { status: "payment_pending" });
    await db.insert(payments).values({
      id: ulid(),
      listingId: draftId,
      userId,
      provider: "stripe",
      checkoutSessionId: "cs_test_paid",
      amountJpy: LISTING_FEE_JPY,
      currency: "jpy",
      status: "succeeded",
    });

    await expect(start(draftId)).rejects.toThrow(/すでにお支払い済み/);
    // Stripe を一切呼んでいないこと。
    expect(calls).toHaveLength(0);
  });
});

/**
 * ★お金を受け取ったのに掲載が出ない、を作らない。★
 *
 * 決済のやり直しで前の Session を失効させると、その
 * checkout.session.expired が新しい決済の最中に届くことがある（実測220ms）。
 * これで投稿が下書きへ戻ると、支払い成立の通知が来ても
 * expectedFrom が合わず、公開されないまま「公開しました」で終わっていた。
 */
describe("★支払い成立と公開が食い違わない★", () => {
  it("下書きへ戻されていても、支払い成立で公開される", async () => {
    // 追い越された失効通知で draft へ戻った状態を作る。
    await db
      .update(listings)
      .set({ status: "draft" })
      .where(eq(listings.id, listingId));

    const result = await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: completedEvent({ id: "evt_draft_recovery" }),
      rawPayload: "{}",
    });

    expect(result.status).toBe("processed");
    expect(await statusOf(listingId)).toBe("published");
    expect(await paymentStatus()).toBe("succeeded");
  });

  it("★公開できなければ失敗として返す（黙って成功にしない）★", async () => {
    // 掲載終了からは公開できない。ここで素通りすると、110円を受け取って
    // 「公開しました」とメールを出したのに掲載が無い状態になる。
    await db
      .update(listings)
      .set({ status: "closed" })
      .where(eq(listings.id, listingId));

    const result = await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: completedEvent({ id: "evt_publish_impossible" }),
      rawPayload: "{}",
    });

    expect(result.status).toBe("failed");
    expect(await statusOf(listingId)).toBe("closed");
  });
});

describe("★追い越された失効通知で決済中の投稿を壊さない★", () => {
  it("新しい決済がある投稿は下書きへ戻さない", async () => {
    // 進行中の（新しい）決済。ULID は時刻順に並ぶので、後から作れば必ず大きい。
    const newerPaymentId = ulid();
    await db.insert(payments).values({
      id: newerPaymentId,
      listingId,
      userId,
      provider: "stripe",
      checkoutSessionId: "cs_test_newer",
      amountJpy: LISTING_FEE_JPY,
      currency: "jpy",
      status: "created",
    });

    // 古いほうの Session が失効した通知が、いま届く。
    const result = await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: {
        id: "evt_superseded_expire",
        type: "checkout.session.expired",
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: sessionId } },
      },
      rawPayload: "{}",
    });

    expect(result.status).toBe("processed");
    // 古い決済記録だけが失効する。
    expect(await paymentStatus()).toBe("expired");
    // ★投稿は決済待ちのまま。★ 下書きへ戻ると、払っている本人に
    // 「お支払いを確認できませんでした」が届く。
    expect(await statusOf(listingId)).toBe("payment_pending");
  });

  it("新しい決済が無ければ、これまで通り下書きへ戻す", async () => {
    const result = await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: {
        id: "evt_plain_expire",
        type: "checkout.session.expired",
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: sessionId } },
      },
      rawPayload: "{}",
    });

    expect(result.status).toBe("processed");
    expect(await paymentStatus()).toBe("expired");
    expect(await statusOf(listingId)).toBe("draft");
  });
});

/**
 * ★返金の処理も、実際に効いたかどうかを見る。★
 *
 * 公開のときと同じ穴が返金側にもあった。transitionListing の戻り値を
 * 見ずに「listing suspended after full refund」を必ず出していたので、
 * 公開されていない投稿の返金でも「停止した」と記録されていた
 * （2026-08-16、preview で下書きの投稿に対して2回出た）。
 */
describe("★返金の記録と実際の状態を食い違わせない★", () => {
  function refundEvent(id: string, amount = LISTING_FEE_JPY): StripeEvent {
    return {
      id,
      type: "charge.refunded",
      created: Math.floor(Date.now() / 1000),
      data: { object: { payment_intent: "pi_test_1", amount_refunded: amount } },
    };
  }

  /** 決済を成功済みにして payment_intent を結びつける */
  async function markSucceeded() {
    await db
      .update(payments)
      .set({ status: "succeeded", paymentIntentId: "pi_test_1" })
      .where(eq(payments.id, paymentId));
  }

  it("同じ返金で3通届いても、確定するのは1通だけ", async () => {
    // ★event_id が違うので Webhook の重複判定では弾けない。★
    // 状態を条件に入れた UPDATE で1通だけが通ることを見る。
    await markSucceeded();
    await db
      .update(listings)
      .set({ status: "published" })
      .where(eq(listings.id, listingId));

    for (const [id, type] of [
      ["evt_multi_1", "charge.refunded"],
      ["evt_multi_2", "refund.created"],
      ["evt_multi_3", "refund.updated"],
    ] as const) {
      await handleStripeEvent({
        db,
        env,
        logger: testLogger,
        event: { ...refundEvent(id), type },
        rawPayload: "{}",
      });
    }

    expect(await paymentStatus()).toBe("refunded");
    expect(await statusOf(listingId)).toBe("suspended");

    // 監査ログは1件だけ。3件出ていたら条件付き UPDATE が効いていない。
    const logs = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.targetId, listingId),
          eq(auditLogs.action, "payment.refunded"),
        ),
      );
    expect(logs).toHaveLength(1);
  });

  it("公開前の投稿の返金でも、決済記録だけは正しく確定する", async () => {
    // 掲載は出ていないので停止しようがない。★それでも黙って
    // 「停止した」ことにしない。★ 決済記録は返金済みになる。
    await markSucceeded();
    await db
      .update(listings)
      .set({ status: "draft" })
      .where(eq(listings.id, listingId));

    const result = await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: refundEvent("evt_refund_draft"),
      rawPayload: "{}",
    });

    expect(result.status).toBe("processed");
    expect(await paymentStatus()).toBe("refunded");
    expect(await statusOf(listingId)).toBe("draft");
  });

  it("★返金済みの決済で公開しない★（返金したのに掲載が出る、を作らない）", async () => {
    // 返金が先に確定し、そのあとで支払い成立の通知が届く順序。
    // イベントの到着順は決済事業者側の都合で決まる。
    await db
      .update(payments)
      .set({ status: "refunded", refundedAmountJpy: LISTING_FEE_JPY })
      .where(eq(payments.id, paymentId));

    const result = await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: completedEvent({ id: "evt_after_refund" }),
      rawPayload: "{}",
    });

    expect(result.status).toBe("failed");
    expect(await statusOf(listingId)).not.toBe("published");
    expect(await paymentStatus()).toBe("refunded");
  });
});

/**
 * ★通知メールを応答の中で待たない。★
 *
 * Webhook の応答時間が平均2.7秒あった（2026-08-16、Stripe の画面で実測）。
 * メール1通で DB を2〜3往復し、さらに送信APIを叩くのを応答の中で待っていた。
 * 決済事業者は応答が遅いと再送するので、速さは正しさにも効く。
 */
describe("★決済の応答に通知メールを待たせない★", () => {
  it("defer を渡すと、公開の確定を終えた時点で応答できる", async () => {
    const deferred: Promise<unknown>[] = [];

    const result = await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: completedEvent({ id: "evt_defer" }),
      rawPayload: "{}",
      defer: (p) => deferred.push(p),
    });

    // 応答を返す時点で、公開も決済記録も確定していること。
    expect(result.status).toBe("processed");
    expect(await statusOf(listingId)).toBe("published");
    expect(await paymentStatus()).toBe("succeeded");

    // ★通知は応答の外に出ている。★ 0件なら待ってしまっている。
    expect(deferred).toHaveLength(1);

    // 預けたぶんは最後まで走りきる（接続を畳む前に片づける前提）。
    await Promise.allSettled(deferred);
  });

  it("defer を渡さなければ、その場で待つ（定期処理とテスト用）", async () => {
    const result = await handleStripeEvent({
      db,
      env,
      logger: testLogger,
      event: completedEvent({ id: "evt_no_defer" }),
      rawPayload: "{}",
    });

    expect(result.status).toBe("processed");
    expect(await statusOf(listingId)).toBe("published");
  });
});
