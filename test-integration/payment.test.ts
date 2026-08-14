import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { listings, payments, paymentWebhookEvents } from "~/db/schema/index.ts";
import { LISTING_FEE_JPY } from "~/domain/pricing";
import { ulid } from "~/domain/ulid";
import type { Db } from "~/server/db.server";
import { handleStripeEvent } from "~/server/services/payment/payment-service.server";
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
          duration_days: "30",
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
