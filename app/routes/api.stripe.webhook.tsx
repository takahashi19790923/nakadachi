import { requireSecret } from "~/server/env.server";
import {
  handleStripeEvent,
} from "~/server/services/payment/payment-service.server";
import { verifyWebhookSignature } from "~/server/services/payment/stripe-client.server";
import type { Route } from "./+types/api.stripe.webhook";
import { getApp } from "~/server/app-context";

/**
 * Stripe の Webhook 受け口。
 *
 * ★ここが「決済成功の正」。★ success URL を踏んだだけでは何も公開しない。
 *
 * 守っていること
 *  1. 署名を必ず検証する。検証前に本文の中身を一切使わない
 *  2. 生の本文をそのまま署名対象にする（JSON.parse して戻すと必ず不一致になる）
 *  3. 同じ event_id は二度処理しない（一意制約で判定）
 *  4. 金額・通貨・投稿ID・利用者IDを突き合わせてから公開する
 *
 * ★CSRF トークンは要求しない。★ 外部からの正当な POST なので、
 * 検証は署名で行う。逆に Origin 検証も行わない（Stripe は付けない）。
 */

/**
 * 署名を確かめる前に受け入れる本文の上限。
 *
 * Stripe の実際のイベントは大きいものでも数十KB。1MB は十分な余裕で、
 * かつ未認証の相手に読ませてよい量としては小さい。
 */
const MAX_WEBHOOK_BYTES = 1_048_576;
export async function action({ request, context: rawContext }: Route.ActionArgs) {
  const context = getApp(rawContext);
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  /*
   * ★署名を確かめる前に、本文の大きさで足切りする。★
   *
   * この口は誰でも叩ける（署名の確認そのものが認証なので、確認前は
   * 未認証の相手を相手にしている）。request.text() は上限を持たないので、
   * 100MB の本文を送られると、署名が合わないと分かる前に全部読み込み、
   * その全体に対して HMAC を2回計算する。攻撃側の費用はほぼゼロで、
   * こちら側だけが CPU を焼く。Stripe の実際のイベントは大きくても
   * 数十KB なので、1MB あれば十分に余裕がある。
   */
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_WEBHOOK_BYTES) {
    context.logger.warn("stripe webhook rejected: body too large", {
      declaredLength,
    });
    return new Response("payload too large", { status: 413 });
  }

  // ★本文はテキストとして読む。★ 署名は生のバイト列に対して計算されている。
  // content-length は自己申告なので、読み切ってからも実測で確かめる。
  const payload = await request.text();
  if (payload.length > MAX_WEBHOOK_BYTES) {
    context.logger.warn("stripe webhook rejected: body too large (actual)", {
      length: payload.length,
    });
    return new Response("payload too large", { status: 413 });
  }

  let event;
  try {
    event = await verifyWebhookSignature({
      payload,
      signatureHeader: request.headers.get("stripe-signature"),
      secret: requireSecret(context.env, "STRIPE_WEBHOOK_SECRET"),
    });
  } catch (error) {
    // ★詳細を返さない。★ 署名の作り方の手がかりを与えない。
    context.logger.warn("stripe webhook signature rejected", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return new Response("invalid signature", { status: 400 });
  }

  const result = await handleStripeEvent({
    db: context.getDb(),
    env: context.env,
    logger: context.logger,
    event,
    rawPayload: payload,
    /*
     * ★通知メールを応答の外へ出す。★ 決済の成否には関係ない処理で、
     * これを待つために応答が平均2.7秒かかっていた（Stripe の画面で実測）。
     * 決済事業者は応答が遅いと再送する。速いほうが二重処理も起きにくい。
     * DB の後始末は defer に預けたものが終わってから行われる。
     */
    defer: context.defer,
  });

  // ★処理に失敗しても 200 を返す。★ 500 を返すと Stripe が再送し続けるが、
  // 同じ入力なら同じ失敗になる。記録を残して運用で拾う（payment_webhook_events
  // の status='failed' を監視する）。
  return new Response(JSON.stringify({ received: true, status: result.status }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export function loader() {
  // GET で叩かれても何も返さない。存在は隠さないが情報も出さない。
  return new Response("Method Not Allowed", { status: 405 });
}
