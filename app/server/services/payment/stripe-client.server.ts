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
    | (T & {
        error?: {
          message?: string;
          code?: string;
          type?: string;
          param?: string;
        };
      })
    | null;

  if (!response.ok || !payload) {
    /*
     * ★message と param を必ず残す。★
     * 以前は status / code / type だけを記録していた。Stripe が
     * パラメータ不備で 400 を返すとき code は付かないことが多く、
     * ログに "code=unknown type=invalid_request_error" とだけ出て、
     * 何が悪いのか一切分からなかった（実際に詰まった）。
     * どの項目が問題かは param に、理由は message に入っている。
     *
     * ★この文字列は AppError の detail に入る。★ detail は運用者向けで、
     * 画面には出ない。利用者に見えるのは別の定型文。
     */
    const e = payload?.error;
    throw new StripeApiError(
      `stripe ${options.path} failed: status=${response.status}` +
        ` type=${e?.type ?? "unknown"} code=${e?.code ?? "unknown"}` +
        ` param=${e?.param ?? "-"} message=${(e?.message ?? "(無し)").slice(0, 200)}`,
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
      /*
       * ★Managed Payments を明示的に切る。★
       *
       * 有効のままだと Stripe が販売者（Merchant of Record）になり、
       * 消費税の納税義務も Stripe 側へ移る。このサービスは
       * 「取引の当事者ではない、場を提供するだけ」と規約に書いており、
       * 特商法の表記でも自社を販売事業者としている。実態と食い違う。
       *
       * ★新しい Stripe アカウントは既定で ON。★ ON のまま作ろうとすると
       *   Invalid line_items[0]: the product tax code is missing
       * で 400 になる。ここで税コードを足すとエラーは消えるが、
       * ★MoR は Stripe のままなので回避になっていない。★
       *
       * アカウント設定側でも切ること（設定 → Managed Payments → 無効にする）。
       * 二重に切る。設定を戻されてもここで止まる。
       */
      managed_payments: { enabled: false },
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

/**
 * まだ支払われていない Checkout Session を、期限前に無効にする。
 *
 * ★同じ投稿に生きた決済リンクを2本作らない。★ 決済をやめて戻ってきた人が
 * もう一度ボタンを押すと新しい Session ができる。古いほうを残すと、
 * 両方の URL が有効なあいだに二重に払える。二重課金は返金では帳消しにならない
 * （利用者の明細には2回出るし、こちらは気づけない）。
 *
 * 支払い済み・期限切れの Session に対しては Stripe が 400 を返す。
 * それは「もう無効にする対象が無い」という意味なので、呼び出し側で握りつぶす。
 */
export async function expireCheckoutSession(options: {
  secretKey: string;
  sessionId: string;
}): Promise<void> {
  await callStripe<CheckoutSession>({
    secretKey: options.secretKey,
    path: `/checkout/sessions/${encodeURIComponent(options.sessionId)}/expire`,
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

/**
 * 1つのヘッダから照合する v1 署名の上限。
 * Stripe が複数付けるのは鍵の切り替え中だけで、実際は2つ（新旧）。
 */
const MAX_SIGNATURE_CANDIDATES = 5;

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

  /*
   * ★候補として受け付ける署名の数を先に区切る。★
   *
   * ヘッダは攻撃者が自由に作れる。v1= を10万個並べたヘッダを送られると、
   * 1つ1つに対して HMAC-SHA256 を計算することになり、1リクエストで
   * こちらの CPU を焼き切れる。攻撃側の費用は文字列を並べるだけ。
   *
   * Stripe が複数の v1 を付けるのは、署名シークレットを切り替えている
   * 最中だけで、実際には2つ（新旧）。5あれば足りる。
   * ヘッダ自体の長さも先に見る（split の前に止める）。
   */
  if (options.signatureHeader.length > 1024) {
    throw new WebhookSignatureError("header too long");
  }

  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of options.signatureHeader.split(",")) {
    const [key, value] = part.split("=", 2);
    if (!key || !value) continue;
    if (key.trim() === "t") timestamp = value.trim();
    if (key.trim() === "v1" && signatures.length < MAX_SIGNATURE_CANDIDATES) {
      signatures.push(value.trim());
    }
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
