import { hmacSha256Hex, timingSafeEqual } from "../../crypto.server.ts";
import { AppError } from "../../errors.ts";

/**
 * Stripe の薄いクライアント。
 *
 * 公式 SDK を使わない理由
 *  1. ★Webhook の署名検証をネットワーク無しで単体テストできる。★
 *     「不正な署名を拒否する」ことが、決済の正しさの土台になる。
 *  2. Workers のバンドル上限に対して、使う機能（3つ）に比べ SDK が大きい。
 *  3. Stripe の API は form-encoded な素直な REST で、抽象化の利得が小さい。
 *
 * 決済事業者を替えられるよう、外へ出す型は Stripe 固有の形にしていない。
 */

const API_BASE = "https://api.stripe.com/v1";

/** 署名の時刻ずれをどこまで許すか。Stripe の推奨は5分 */
const SIGNATURE_TOLERANCE_SECONDS = 300;

export class StripeApiError extends AppError {
  constructor(detail: string) {
    super("payment_failed", "決済手続きを開始できませんでした。時間をおいてお試しください。", {
      detail,
    });
    this.name = "StripeApiError";
  }
}

/** ネストしたオブジェクトを Stripe の form-encoded 形式へ落とす */
function toFormBody(
  input: Record<string, unknown>,
  prefix = "",
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of toFormBody(value as Record<string, unknown>, name)) {
        params.append(k, v);
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "object" && item !== null) {
          for (const [k, v] of toFormBody(
            item as Record<string, unknown>,
            `${name}[${index}]`,
          )) {
            params.append(k, v);
          }
        } else {
          params.append(`${name}[${index}]`, String(item));
        }
      });
    } else {
      params.append(name, scalarToString(value));
    }
  }
  return params;
}

/**
 * 数値・真偽・文字列だけを文字列にする。
 * それ以外は空にする（オブジェクトを String() にかけると
 * "[object Object]" が決済事業者へ送られてしまう）。
 */
function scalarToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

async function callStripe<T>(options: {
  secretKey: string;
  path: string;
  body?: Record<string, unknown>;
  method?: "GET" | "POST";
  idempotencyKey?: string;
}): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.secretKey}`,
    "content-type": "application/x-www-form-urlencoded",
    // 版を固定する。Stripe が既定の版を上げても応答の形が変わらない。
    "stripe-version": "2025-08-27.basil",
  };
  if (options.idempotencyKey) {
    // 画面の連打やリトライで Session が二重にできるのを Stripe 側でも止める。
    headers["idempotency-key"] = options.idempotencyKey.slice(0, 255);
  }

  const response = await fetch(`${API_BASE}${options.path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.body ? toFormBody(options.body).toString() : undefined,
  });

  // ★応答本文を必ず読み切る。★ 読まずに return すると接続が開いたままになる。
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: { message?: string; code?: string; type?: string } })
    | null;

  if (!response.ok || !payload) {
    // ★事業者の生メッセージを利用者へ出さない。★ ログにだけ残す。
    throw new StripeApiError(
      `stripe ${options.path} failed: status=${response.status} code=${payload?.error?.code ?? "unknown"} type=${payload?.error?.type ?? "unknown"}`,
    );
  }
  return payload;
}

// ── Checkout Session ──────────────────────────────────────────────

export interface CheckoutSession {
  readonly id: string;
  readonly url: string | null;
  readonly payment_intent: string | null;
  readonly amount_total: number | null;
  readonly currency: string | null;
  readonly payment_status: string;
  readonly status: string;
  readonly metadata: Record<string, string> | null;
  readonly client_reference_id: string | null;
}

export async function createCheckoutSession(options: {
  secretKey: string;
  amountJpy: number;
  currency: string;
  productName: string;
  productDescription: string;
  successUrl: string;
  cancelUrl: string;
  clientReferenceId: string;
  metadata: Record<string, string>;
  expiresAt: Date;
  idempotencyKey: string;
}): Promise<CheckoutSession> {
  return callStripe<CheckoutSession>({
    secretKey: options.secretKey,
    path: "/checkout/sessions",
    idempotencyKey: options.idempotencyKey,
    body: {
      mode: "payment",
      locale: "ja",
      success_url: options.successUrl,
      cancel_url: options.cancelUrl,
      client_reference_id: options.clientReferenceId,
      // ★Session の有効期限を明示する。★ 放置された決済待ちの投稿を
      // 下書きへ戻す判断に使う。最短30分・最長24時間。
      expires_at: Math.floor(options.expiresAt.getTime() / 1000),
      metadata: options.metadata,
      // PaymentIntent 側にも同じ metadata を載せる。返金や係争のイベントには
      // Session の情報が付かないため、そこからも投稿を辿れるようにする。
      payment_intent_data: { metadata: options.metadata },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: options.currency,
            // 日本円は最小単位が円そのもの。110 は 110円であって 1.10円ではない。
            unit_amount: options.amountJpy,
            // 表示価格を税込として扱う（特商法表記と一致させる）。
            tax_behavior: "inclusive",
            product_data: {
              name: options.productName,
              description: options.productDescription,
            },
          },
        },
      ],
    },
  });
}

export async function retrieveCheckoutSession(options: {
  secretKey: string;
  sessionId: string;
}): Promise<CheckoutSession> {
  return callStripe<CheckoutSession>({
    secretKey: options.secretKey,
    path: `/checkout/sessions/${encodeURIComponent(options.sessionId)}`,
    method: "GET",
  });
}

export interface StripeRefund {
  readonly id: string;
  readonly amount: number;
  readonly status: string;
  readonly charge: string | null;
  readonly payment_intent: string | null;
}

export async function createRefund(options: {
  secretKey: string;
  paymentIntentId: string;
  amountJpy?: number;
  reason?: "requested_by_customer" | "duplicate" | "fraudulent";
  idempotencyKey: string;
}): Promise<StripeRefund> {
  return callStripe<StripeRefund>({
    secretKey: options.secretKey,
    path: "/refunds",
    idempotencyKey: options.idempotencyKey,
    body: {
      payment_intent: options.paymentIntentId,
      amount: options.amountJpy,
      reason: options.reason ?? "requested_by_customer",
    },
  });
}

// ── Webhook の署名検証 ────────────────────────────────────────────

export class WebhookSignatureError extends Error {
  constructor(reason: string) {
    super(`webhook signature rejected: ${reason}`);
    this.name = "WebhookSignatureError";
  }
}

export interface StripeEvent {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly data: { object: Record<string, unknown> };
}

/**
 * Stripe-Signature ヘッダを検証して、イベントを取り出す。
 *
 * ヘッダの形: `t=1699999999,v1=<hex>,v1=<hex>`
 * 署名対象は `${t}.${生の本文}`。
 *
 * ★本文は生のバイト列そのものを使うこと。★ JSON.parse して stringify し直すと
 * キーの順序や空白が変わり、署名が必ず合わなくなる。
 *
 * ★v1 が複数あることがある（署名鍵のローテーション中）。どれか1つ合えば通す。★
 */
export async function verifyWebhookSignature(options: {
  payload: string;
  signatureHeader: string | null;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): Promise<StripeEvent> {
  if (!options.signatureHeader) {
    throw new WebhookSignatureError("header missing");
  }

  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of options.signatureHeader.split(",")) {
    const [key, value] = part.split("=", 2);
    if (!key || !value) continue;
    if (key.trim() === "t") timestamp = value.trim();
    if (key.trim() === "v1") signatures.push(value.trim());
  }

  if (!timestamp || signatures.length === 0) {
    throw new WebhookSignatureError("timestamp or v1 missing");
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    throw new WebhookSignatureError("timestamp malformed");
  }

  // 時刻のずれを見る。無いと、盗んだリクエストを何日後でも再生できる。
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(now - timestampSeconds) > tolerance) {
    throw new WebhookSignatureError("timestamp outside tolerance");
  }

  const expected = await hmacSha256Hex(
    options.secret,
    `${timestamp}.${options.payload}`,
  );

  let matched = false;
  for (const candidate of signatures) {
    // 定数時間で比べる。全件を必ず評価してから判定する。
    if (await timingSafeEqual(expected, candidate)) matched = true;
  }
  if (!matched) throw new WebhookSignatureError("no matching v1 signature");

  let event: StripeEvent;
  try {
    event = JSON.parse(options.payload) as StripeEvent;
  } catch {
    throw new WebhookSignatureError("payload is not valid json");
  }

  if (!event.id || !event.type || !event.data) {
    throw new WebhookSignatureError("payload missing required fields");
  }
  return event;
}
