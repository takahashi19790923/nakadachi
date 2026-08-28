import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCheckoutSession } from "~/server/services/payment/stripe-client.server";

/**
 * Checkout Session を作るときに Stripe へ渡す中身。
 *
 * ★「誰が販売者か」と「いくらで確定するか」を決める指定が、
 * 一度も検査されていなかった。★ 消えても型は通り、テストは全部緑で、
 * 気づけるのは本番で決済が壊れてから、という位置にある。
 *
 * ここで固定するのは2つ。どちらも★アカウント設定の既定が ON★で、
 * ★サンドボックスと本番で既定が違いうる★。設定に任せず毎回明示する。
 *
 *  managed_payments  ON だと Stripe が販売者（MoR）になる。規約と
 *                    特商法の表記では自社を販売事業者としているので食い違う。
 *
 *  adaptive_pricing  ON だと国外からの購入で現地通貨へ換算され、Session の
 *                    currency と amount_total が換算後になる。こちらの検証は
 *                    110/jpy の完全一致なので、★支払いは成立しているのに
 *                    公開されない★（amount_mismatch）。決済事業者の画面では
 *                    成功に見え、こちらの画面にもエラーは出ない。
 */

const CALL = {
  secretKey: "sk_test_not_a_real_key",
  amountJpy: 110,
  currency: "jpy",
  productName: "掲載料",
  productDescription: "30日間の掲載",
  successUrl: "https://example.test/ok",
  cancelUrl: "https://example.test/ng",
  clientReferenceId: "01ABCDEFGHJKMNPQRSTVWXYZ00",
  metadata: { listing_id: "01ABCDEFGHJKMNPQRSTVWXYZ00", user_id: "01USER" },
  expiresAt: new Date("2026-08-29T03:00:00Z"),
  idempotencyKey: "checkout:01ABCDEFGHJKMNPQRSTVWXYZ00",
};

let sentBody: URLSearchParams;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      /*
       * ★body は文字列であることを確かめてから受け取る。★ 素の String() に
       * かけると、形が変わった日に "[object Object]" を解析して
       * 「全部空だが例外は出ない」テストになる（＝常に緑）。
       */
      const body = init.body;
      if (typeof body !== "string") {
        throw new TypeError(`body が文字列ではありません: ${typeof body}`);
      }
      sentBody = new URLSearchParams(body);
      return Promise.resolve(
        new Response(JSON.stringify({ id: "cs_test_x", url: "https://x" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("★Stripe へ渡す指定を固定する★", () => {
  it("Managed Payments を明示的に切っている（Stripe を販売者にしない）", async () => {
    await createCheckoutSession(CALL);
    expect(sentBody.get("managed_payments[enabled]")).toBe("false");
  });

  it("★Adaptive Pricing を明示的に切っている（通貨を換算させない）★", async () => {
    await createCheckoutSession(CALL);
    expect(sentBody.get("adaptive_pricing[enabled]")).toBe("false");
  });

  it("金額と通貨はサーバー側の値をそのまま渡す", async () => {
    await createCheckoutSession(CALL);
    expect(sentBody.get("line_items[0][price_data][unit_amount]")).toBe("110");
    expect(sentBody.get("line_items[0][price_data][currency]")).toBe("jpy");
    // 日本円の最小単位は円そのもの。110 は 110円であって 1.10円ではない。
    expect(sentBody.get("line_items[0][quantity]")).toBe("1");
  });

  it("Session の有効期限を必ず渡す（放置された決済待ちを戻す判断に使う）", async () => {
    await createCheckoutSession(CALL);
    expect(sentBody.get("expires_at")).toBe(
      String(Math.floor(CALL.expiresAt.getTime() / 1000)),
    );
  });

  it("★PaymentIntent 側にも metadata を載せる★", async () => {
    /*
     * 返金・係争のイベントには Session の情報が付かない。ここが抜けると
     * 「返金は届いたが、どの投稿か分からない」になる。
     */
    await createCheckoutSession(CALL);
    expect(sentBody.get("payment_intent_data[metadata][listing_id]")).toBe(
      CALL.metadata.listing_id,
    );
  });
});
