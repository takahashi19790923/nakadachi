import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";

import { listings, payments, paymentWebhookEvents } from "~/db/schema/index.ts";
import {
  isValidListingFeePayment,
  LISTING_FEE_CURRENCY,
  LISTING_FEE_JPY,
} from "~/domain/pricing";
import { ulid } from "~/domain/ulid.ts";
import { writeAuditLog } from "../../audit.server.ts";
import { sha256Hex } from "../../crypto.server.ts";
import type { Db } from "../../db.server.ts";
import { requireSecret, type AppEnv } from "../../env.server.ts";
import { AppError, notFound } from "../../errors.ts";
import type { Logger } from "../../logger.server.ts";
import { transitionListing } from "../listing-service.server.ts";
import {
  notifyListingPublished,
  notifyPaymentFailed,
} from "../notification-service.server.ts";
import {
  createCheckoutSession,
  createRefund,
  expireCheckoutSession,
  type StripeEvent,
} from "./stripe-client.server.ts";

/**
 * 決済のサービス層。
 *
 * 守っていること
 *  - ★金額はサーバー側の定数から組み立てる。★ クライアントから来た値は使わない
 *  - ★公開は署名検証済み Webhook を受けてからだけ。★ success URL では変えない
 *  - ★同じ投稿に二重課金しない。★ 成功済みの決済があれば新しい Session を作らない
 *  - ★同じ Webhook を二度処理しない。★ event_id の一意制約で判定する
 */

/** Checkout Session の有効期間。放置された決済待ちを下書きへ戻す判断に使う */
const SESSION_TTL_MINUTES = 60;

export interface CheckoutStartResult {
  readonly redirectUrl: string;
  readonly paymentId: string;
}

/**
 * 掲載料の決済を開始する。
 *
 * 呼ぶ前に「その投稿がこの利用者のものか」を必ず確かめること
 * （guards.server.ts の assertOwner）。
 */
export async function startListingCheckout(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  request: Request;
  listingId: string;
  userId: string;
  durationDays: number;
}): Promise<CheckoutStartResult> {
  const { db, env, logger, listingId, userId } = options;

  const rows = await db
    .select({
      id: listings.id,
      ownerId: listings.ownerId,
      status: listings.status,
      title: listings.title,
    })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1);

  const listing = rows[0];
  if (!listing) throw notFound(`listing not found: ${listingId}`);
  if (listing.ownerId !== userId) {
    // 所有者でない場合は存在も知らせない。
    throw notFound(`checkout attempted by non-owner: ${listingId}`);
  }

  // ★すでに支払い済みなら二度と課金しない。★
  const existingPaid = await db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(eq(payments.listingId, listingId), eq(payments.status, "succeeded")),
    )
    .limit(1);

  if (existingPaid.length > 0) {
    throw new AppError(
      "conflict",
      "この投稿の掲載料はすでにお支払い済みです。",
      { detail: `duplicate checkout for paid listing: ${listingId}` },
    );
  }

  if (listing.status !== "draft" && listing.status !== "payment_pending") {
    throw new AppError("conflict", "この投稿は決済に進める状態ではありません。", {
      detail: `checkout attempted on status=${listing.status}`,
    });
  }

  // やり直しのとき無効にする、前回ぶんの決済。無効化は下で行う。
  const stripeSecretKey = requireSecret(env, "STRIPE_SECRET_KEY");
  const openPayments = await db
    .select({ id: payments.id, checkoutSessionId: payments.checkoutSessionId })
    .from(payments)
    .where(
      and(
        eq(payments.listingId, listingId),
        inArray(payments.status, ["created", "pending"]),
      ),
    );

  const paymentId = ulid();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000);

  const session = await createCheckoutSession({
    secretKey: stripeSecretKey,
    // ★ここが金額の唯一の出どころ。★
    amountJpy: LISTING_FEE_JPY,
    currency: LISTING_FEE_CURRENCY,
    productName: "投稿の掲載料",
    productDescription: "1件の掲載につき110円（税込）。これ以外の料金はかかりません。",
    successUrl: new URL(
      `/listings/${listingId}/pending`,
      env.APP_ORIGIN,
    ).toString(),
    cancelUrl: new URL(
      `/listings/${listingId}/confirm?canceled=1`,
      env.APP_ORIGIN,
    ).toString(),
    clientReferenceId: listingId,
    metadata: {
      listing_id: listingId,
      user_id: userId,
      payment_id: paymentId,
      duration_days: String(options.durationDays),
    },
    expiresAt,
    // 画面の連打で Session が二重にできるのを Stripe 側でも止める。
    idempotencyKey: `checkout:${paymentId}`,
  });

  if (!session.url) {
    throw new AppError("payment_failed", "決済画面を開けませんでした。", {
      detail: `session ${session.id} has no url`,
    });
  }

  await db.insert(payments).values({
    id: paymentId,
    listingId,
    userId,
    provider: "stripe",
    checkoutSessionId: session.id,
    amountJpy: LISTING_FEE_JPY,
    currency: LISTING_FEE_CURRENCY,
    status: "created",
  });

  /*
   * ★前の Session を無効にするのは、新しい決済記録を入れたあと。★
   *
   * 無効にしないと、決済リンクが2本とも生きたままになる。
   * ★二重課金は返金では帳消しにならない。★ 利用者の明細には2回残るし、
   * こちらのエラーにも Stripe のエラーにも出ないので誰も気づけない。
   *
   * ★順番が肝。★ /expire を呼ぶと Stripe は checkout.session.expired を
   * ただちに送ってくる。実測220ミリ秒で戻ってきた（2026-08-16、preview）。
   * 先に無効化すると、この通知が新しい決済記録を入れるより早く着き、
   * handleSessionFailed が「決済が失効した」と判断して投稿を下書きへ戻す。
   * 払っている本人に「お支払いを確認できませんでした」が届く。
   * 新しい記録を先に入れておけば、あちらは追い越された通知だと分かる。
   *
   * 無効化に失敗しても決済の開始は止めない。ここで止めると
   * 「一度やめると二度と払えない投稿」ができる。
   */
  for (const open of openPayments) {
    try {
      await expireCheckoutSession({
        secretKey: stripeSecretKey,
        sessionId: open.checkoutSessionId,
      });
    } catch (error) {
      // 支払い済み・期限切れなら Stripe が 400 を返す。無効にする対象が
      // 無いだけなので進める。
      logger.warn("failed to expire previous checkout session", {
        listingId,
        paymentId: open.id,
        detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }
    await db
      .update(payments)
      .set({ status: "expired" })
      .where(eq(payments.id, open.id));
  }

  /*
   * ★すでに payment_pending なら遷移させない。★
   *
   * 遷移表に payment_pending → payment_pending は無い（意図的。状態が
   * 変わらない「遷移」を通すと、遷移表が守っているものが緩む）。
   * ここを無条件に呼ぶと、決済をやめて戻ってきた人が
   * ★もう一度ボタンを押した瞬間に必ず失敗する。★ しかも Session と
   * payments 行を作った後で落ちるので、押すたびに捨て子が増える。
   * 実際に踏んだ（2026-08-16、preview）。
   * 状態が payment_pending へ戻るまでは checkout.session.expired 待ちで、
   * 最長60分そのまま。「なぜか払えない投稿」になる。
   */
  if (listing.status === "draft") {
    await transitionListing(db, {
      listingId,
      to: "payment_pending",
      actor: "owner",
    });
  }

  await writeAuditLog(db, env, {
    action: "payment.checkout_started",
    actorId: userId,
    targetType: "listing",
    targetId: listingId,
    request: options.request,
    metadata: { amountJpy: LISTING_FEE_JPY },
  });

  logger.info("checkout session created", { listingId, paymentId });
  return { redirectUrl: session.url, paymentId };
}

// ── Webhook ───────────────────────────────────────────────────────

export interface WebhookHandleResult {
  readonly status: "processed" | "duplicate" | "ignored" | "failed";
  readonly detail?: string;
}

/** 実際に扱うイベント。ほかは記録だけして無視する */
const HANDLED_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "charge.refunded",
  "refund.created",
  "refund.updated",
  "charge.dispute.created",
]);

/**
 * Webhook の本体。署名検証は呼び出し側（ルート）で済ませてから渡す。
 *
 * ★冪等性の根拠は event_id の一意制約。★ アプリのメモリや条件分岐で
 * 「処理済みか」を判断すると、同時に2通届いたときに二重処理する。
 * INSERT が落ちることをもって「すでに処理済み」と判定する。
 */
export async function handleStripeEvent(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  event: StripeEvent;
  rawPayload: string;
}): Promise<WebhookHandleResult> {
  // env は個々のハンドラへ options ごと渡す（この関数自体では使わない）。
  const { db, logger, event } = options;

  const inserted = await db
    .insert(paymentWebhookEvents)
    .values({
      id: ulid(),
      provider: "stripe",
      eventId: event.id,
      eventType: event.type,
      // ★本文そのものを保存しない。★ 氏名・住所が入りうる。
      payloadDigest: await sha256Hex(options.rawPayload),
      status: "received",
    })
    .onConflictDoNothing({
      target: [paymentWebhookEvents.provider, paymentWebhookEvents.eventId],
    });

  if ((inserted.rowCount ?? 0) === 0) {
    logger.info("webhook already processed", { eventType: event.type });
    return { status: "duplicate" };
  }

  if (!HANDLED_EVENTS.has(event.type)) {
    await markEvent(db, event.id, "ignored");
    return { status: "ignored" };
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        await handleSessionSucceeded(options);
        break;
      case "checkout.session.async_payment_failed":
        await handleSessionFailed(options, "async_payment_failed");
        break;
      case "checkout.session.expired":
        await handleSessionFailed(options, "session_expired");
        break;
      case "charge.refunded":
      case "refund.created":
      case "refund.updated":
        await handleRefundEvent(options);
        break;
      case "charge.dispute.created":
        await handleDispute(options);
        break;
      default:
        break;
    }
    await markEvent(db, event.id, "processed");
    return { status: "processed" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await markEvent(db, event.id, "failed", detail);
    logger.error("webhook handling failed", error, { eventType: event.type });
    // ★ここで例外を投げ直さない。★ 500 を返すと Stripe が再送し続けるが、
    // 同じ入力なら同じ失敗になる。記録を残して 200 を返し、運用で拾う。
    return { status: "failed", detail };
  }
}

async function markEvent(
  db: Db,
  eventId: string,
  status: "processed" | "ignored" | "failed",
  errorMessage?: string,
): Promise<void> {
  await db
    .update(paymentWebhookEvents)
    .set({
      status,
      processedAt: new Date(),
      errorMessage: errorMessage?.slice(0, 500) ?? null,
      updatedAt: new Date(),
    })
    .where(eq(paymentWebhookEvents.eventId, eventId));
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function readMetadata(
  source: Record<string, unknown>,
): Record<string, string> {
  const value = source.metadata;
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * 支払い完了。ここだけが投稿を公開できる。
 *
 * 検証する4点（1つでも合わなければ公開しない）
 *   1. 支払われた金額が 110円ちょうどか
 *   2. 通貨が jpy か
 *   3. metadata の listing_id が payments の行と一致するか
 *   4. metadata の user_id が payments の行と一致するか
 */
async function handleSessionSucceeded(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  event: StripeEvent;
}): Promise<void> {
  const { db, env, logger, event } = options;
  const session = event.data.object;

  const sessionId = readString(session, "id");
  if (!sessionId) throw new Error("session id missing");

  const paymentStatus = readString(session, "payment_status");
  if (paymentStatus !== "paid") {
    // 後払いの手段では completed でも未入金のことがある。確認中で止める。
    await db
      .update(payments)
      .set({ status: "pending", updatedAt: new Date() })
      .where(eq(payments.checkoutSessionId, sessionId));

    const pendingRow = await findPaymentBySession(db, sessionId);
    if (pendingRow) {
      await transitionListing(db, {
        listingId: pendingRow.listingId,
        to: "payment_processing",
        actor: "system",
        expectedFrom: "payment_pending",
      });
    }
    logger.info("checkout completed but not paid yet", { sessionId });
    return;
  }

  const amountTotal = session.amount_total;
  const currency = readString(session, "currency");

  const payment = await findPaymentBySession(db, sessionId);
  if (!payment) {
    // 自分のアカウント宛でない、あるいは記録が消えている。公開しない。
    throw new Error(`no payment row for session ${sessionId}`);
  }

  const metadata = readMetadata(session);

  if (
    !isValidListingFeePayment(
      typeof amountTotal === "number" ? amountTotal : null,
      currency,
    )
  ) {
    await db
      .update(payments)
      .set({
        status: "failed",
        failureCode: "amount_mismatch",
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));
    throw new Error(
      `amount/currency mismatch: got=${String(amountTotal)}/${String(currency)} expected=${LISTING_FEE_JPY}/${LISTING_FEE_CURRENCY}`,
    );
  }

  if (
    metadata.listing_id !== payment.listingId ||
    metadata.user_id !== payment.userId
  ) {
    await db
      .update(payments)
      .set({
        status: "failed",
        failureCode: "metadata_mismatch",
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));
    throw new Error(`metadata mismatch for session ${sessionId}`);
  }

  const durationDays = Number(metadata.duration_days);
  const paymentIntentId = readString(session, "payment_intent");

  // ★決済記録と公開を同じトランザクションで更新する。★
  // 片方だけ成立すると「課金したのに公開されない」「無料で公開された」になる。
  let published = false;
  await db.transaction(async (tx) => {
    await tx
      .update(payments)
      .set({
        status: "succeeded",
        paidAt: new Date(),
        paymentIntentId,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));

    /*
     * ★どこから公開できたかを必ず確かめる。★
     *
     * expectedFrom を渡すのは、同じイベントが同時に2つ来ても1回しか
     * 成立させないため。ただし expectedFrom が合わないと
     * transitionListing は例外を投げず changed:false を返すだけなので、
     * ★戻り値を見ないと「公開したつもりで公開していない」が素通りする。★
     * 実際に踏んだ（2026-08-16、preview）。110円は取れていて、ログは
     * 「listing published after payment」、利用者には公開通知メール、
     * それでも掲載は下書きのまま。どこにも異常が出ない。
     *
     * draft を候補に入れているのは、決済のやり直しで前の Session を
     * 失効させたとき、その checkout.session.expired が新しい決済の最中に
     * 届いて投稿を下書きへ戻すことがあるため（下の handleSessionFailed で
     * 防いではいるが、届く順序は決済事業者側の都合で決まる）。
     * ★お金を受け取った以上、掲載は必ず出す。★
     */
    for (const from of ["payment_pending", "payment_processing", "draft"] as const) {
      const result = await transitionListing(tx, {
        listingId: payment.listingId,
        to: "published",
        // ★ここだけが payment を渡してよい場所。★ 金額・通貨・metadata の
        // 照合を終えた、署名検証済み Webhook の支払い成立処理。
        actor: "payment",
        durationDays: Number.isFinite(durationDays) ? durationDays : undefined,
        expectedFrom: from,
        tx,
      });
      if (result.changed) {
        published = true;
        break;
      }
      // すでに公開済みなら、同じ決済が二重に届いただけ。成立とみなす。
      if (result.from === "published") {
        published = true;
        break;
      }
    }
  });

  if (!published) {
    /*
     * 決済は成立したのに掲載を出せなかった。★黙って終わらせない。★
     * 例外にして Webhook を失敗で返すと Stripe が再送してくれる。
     * 公開通知メールもここで止まる（出していない掲載を
     * 「公開しました」と知らせない）。
     */
    logger.error(
      "payment succeeded but listing was not published",
      new Error("publish transition did not apply"),
      { listingId: payment.listingId, paymentId: payment.id },
    );
    throw new AppError(
      "conflict",
      "掲載の公開に失敗しました。",
      { detail: `paid but not published: listing=${payment.listingId}` },
    );
  }

  await writeAuditLog(db, env, {
    action: "payment.succeeded",
    actorId: payment.userId,
    actorRole: "system",
    targetType: "listing",
    targetId: payment.listingId,
    metadata: { amountJpy: LISTING_FEE_JPY },
  });

  // ★メールの失敗で公開を巻き戻さない。★ 冪等キーがあるので、あとから
  // 同じ鍵で再送しても二重には届かない。
  await notifyListingPublished({
    db,
    env,
    logger,
    listingId: payment.listingId,
    userId: payment.userId,
  }).catch((error: unknown) => {
    logger.error("publish notification failed", error, {
      listingId: payment.listingId,
    });
  });

  logger.info("listing published after payment", {
    listingId: payment.listingId,
  });
}

/**
 * Session ID から決済記録を引く。
 *
 * ★退会で参照が外れた行（listing_id / user_id が null）は返さない。★
 * 決済の記録としては残すが、公開や通知の対象にはならない。
 * ここで弾いておかないと、消えた投稿を公開しようとして落ちる。
 */
async function findPaymentBySession(db: Db, sessionId: string) {
  const rows = await db
    .select({
      id: payments.id,
      listingId: payments.listingId,
      userId: payments.userId,
      status: payments.status,
      amountJpy: payments.amountJpy,
      paymentIntentId: payments.paymentIntentId,
    })
    .from(payments)
    .where(eq(payments.checkoutSessionId, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row?.listingId || !row.userId) return null;
  return { ...row, listingId: row.listingId, userId: row.userId };
}

/** payment_intent から引く版。同じく参照が外れた行は返さない */
async function findPaymentByIntent(db: Db, paymentIntentId: string) {
  const rows = await db
    .select({
      id: payments.id,
      listingId: payments.listingId,
      userId: payments.userId,
      amountJpy: payments.amountJpy,
      status: payments.status,
    })
    .from(payments)
    .where(eq(payments.paymentIntentId, paymentIntentId))
    .limit(1);

  const row = rows[0];
  if (!row?.listingId || !row.userId) return null;
  return { ...row, listingId: row.listingId, userId: row.userId };
}

/** 決済の失敗・失効。投稿は下書きへ戻す（再課金は発生しない） */
async function handleSessionFailed(
  options: { db: Db; env: AppEnv; logger: Logger; event: StripeEvent },
  reason: string,
): Promise<void> {
  const { db, event } = options;
  // env と logger は下の通知でオプション経由で使う。
  const sessionId = readString(event.data.object, "id");
  if (!sessionId) throw new Error("session id missing");

  const payment = await findPaymentBySession(db, sessionId);
  if (!payment) return;
  if (payment.status === "succeeded") {
    // 支払い済みの Session に対する失効通知は無視する。
    return;
  }

  await db
    .update(payments)
    .set({
      status: reason === "session_expired" ? "expired" : "failed",
      failureCode: reason,
      updatedAt: new Date(),
    })
    .where(eq(payments.id, payment.id));

  /*
   * ★追い越された失効通知で、進行中の決済を壊さない。★
   *
   * 決済をやめて戻ってきた人がもう一度押すと、こちらは前の Session を
   * 失効させてから新しい Session を作る。すると Stripe は
   * checkout.session.expired をすぐ送ってくる。これが
   * ★新しい決済の最中に届く。★（実測220ms、2026-08-16 preview）
   *
   * そのまま処理すると、いま払おうとしている投稿が下書きへ戻り、
   * 「お支払いを確認できませんでした」というメールまで届く。
   * 払っている本人にこれが出る。
   *
   * この投稿に、この決済より新しい決済記録があるなら、それは
   * 追い越された古い通知。決済記録の状態だけ直して投稿には触らない。
   */
  const newer = await db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.listingId, payment.listingId),
        gt(payments.id, payment.id),
      ),
    )
    .limit(1);

  if (newer.length > 0) {
    options.logger.info("ignored superseded checkout failure", {
      listingId: payment.listingId,
      paymentId: payment.id,
      reason,
    });
    return;
  }

  for (const from of ["payment_pending", "payment_processing"] as const) {
    const result = await transitionListing(db, {
      listingId: payment.listingId,
      to: "draft",
      actor: "system",
      expectedFrom: from,
    });
    if (result.changed) break;
  }

  await notifyPaymentFailed({
    db,
    env: options.env,
    logger: options.logger,
    listingId: payment.listingId,
    userId: payment.userId,
    attempt: payment.id,
  }).catch((error: unknown) => {
    options.logger.error("payment failure notification failed", error);
  });
}

/**
 * 返金。
 *
 * ★自サイト宛かの判別を決済リンクIDで行えない。★ charge / refund /
 * dispute のイベントには Session の情報が付かない。
 * 「その PaymentIntent で作った決済が自分の DB にあるか」で判別する。
 *
 * ★同じ返金で複数種類のイベントが届く。★ すでに無効なら何もしない。
 */
async function handleRefundEvent(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  event: StripeEvent;
}): Promise<void> {
  const { db, env, logger, event } = options;
  const object = event.data.object;

  const paymentIntentId = readString(object, "payment_intent");
  if (!paymentIntentId) return;

  const payment = await findPaymentByIntent(db, paymentIntentId);
  if (!payment) return; // 他サービスの決済。自分の DB に無いので無視する

  if (payment.status === "refunded" || payment.status === "disputed") {
    // すでに止めてある。監査ログを重ねない。
    return;
  }

  // 全額返金かを判定する。一部返金では止めない（手数料相当だけ返す運用で
  // 締め出さないため）。
  const refundedAmount =
    typeof object.amount_refunded === "number"
      ? object.amount_refunded
      : typeof object.amount === "number"
        ? object.amount
        : 0;

  const isFullRefund = refundedAmount >= payment.amountJpy;

  await db
    .update(payments)
    .set({
      status: isFullRefund ? "refunded" : "partially_refunded",
      refundedAmountJpy: refundedAmount,
      refundedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(payments.id, payment.id));

  if (!isFullRefund) return;

  // ★返金したのに掲載が続く状態を作らない。★
  await transitionListing(db, {
    listingId: payment.listingId,
    to: "suspended",
    actor: "system",
    expectedFrom: "published",
    moderationReason: "掲載料が返金されたため、掲載を停止しました。",
  });

  await writeAuditLog(db, env, {
    action: "payment.refunded",
    actorId: payment.userId,
    actorRole: "system",
    targetType: "listing",
    targetId: payment.listingId,
    metadata: { refundedAmountJpy: refundedAmount },
  });

  logger.warn("listing suspended after full refund", {
    listingId: payment.listingId,
  });
}

/** 係争。金額に関わらず止める（入金ごと取り上げられる） */
async function handleDispute(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  event: StripeEvent;
}): Promise<void> {
  const { db, env, event } = options;
  const paymentIntentId = readString(event.data.object, "payment_intent");
  if (!paymentIntentId) return;

  const payment = await findPaymentByIntent(db, paymentIntentId);
  if (!payment) return;

  await db
    .update(payments)
    .set({ status: "disputed", updatedAt: new Date() })
    .where(eq(payments.id, payment.id));

  await transitionListing(db, {
    listingId: payment.listingId,
    to: "suspended",
    actor: "system",
    expectedFrom: "published",
    moderationReason: "決済に関する申し立てがあったため、掲載を停止しました。",
  });

  await writeAuditLog(db, env, {
    action: "payment.disputed",
    actorRole: "system",
    targetType: "listing",
    targetId: payment.listingId,
  });
}

// ── 管理画面からの返金 ────────────────────────────────────────────

/**
 * 返金を実行する。★管理画面から明示的に呼ぶときだけ。★
 * 管理者による非公開では自動返金しない（ビジネスルール）。
 */
export async function refundPayment(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  paymentId: string;
  adminId: string;
}): Promise<void> {
  const { db, env, paymentId } = options;

  const rows = await db
    .select({
      id: payments.id,
      paymentIntentId: payments.paymentIntentId,
      amountJpy: payments.amountJpy,
      status: payments.status,
    })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  const payment = rows[0];
  if (!payment) throw notFound(`payment not found: ${paymentId}`);
  if (payment.status !== "succeeded") {
    throw new AppError("conflict", "この決済は返金できる状態ではありません。", {
      detail: `refund attempted on status=${payment.status}`,
    });
  }
  if (!payment.paymentIntentId) {
    throw new AppError("conflict", "決済情報が不足しているため返金できません。", {
      detail: `payment ${paymentId} has no payment_intent`,
    });
  }

  await createRefund({
    secretKey: requireSecret(env, "STRIPE_SECRET_KEY"),
    paymentIntentId: payment.paymentIntentId,
    amountJpy: payment.amountJpy,
    idempotencyKey: `refund:${paymentId}`,
  });

  // 実際の状態更新は Webhook（refund.created / charge.refunded）で行う。
  // ここで先に書き換えると、Stripe 側が失敗したときに食い違う。
}

/** 決済履歴。マイページと管理画面で使う */
export async function listPayments(
  db: Db,
  options: { userId?: string; limit?: number } = {},
) {
  const conditions = options.userId ? [eq(payments.userId, options.userId)] : [];
  // ★leftJoin にする。★ 退会で投稿が消えても決済の記録は残るため、
  // innerJoin だと会計の突き合わせから行が抜け落ちる。
  return db
    .select({
      id: payments.id,
      listingId: payments.listingId,
      listingTitle: listings.title,
      amountJpy: payments.amountJpy,
      currency: payments.currency,
      status: payments.status,
      paidAt: payments.paidAt,
      refundedAmountJpy: payments.refundedAmountJpy,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .leftJoin(listings, eq(listings.id, payments.listingId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(payments.createdAt))
    .limit(options.limit ?? 100);
}

/** 決済待ちの投稿が公開されたかを確認する。/listings/:id/pending が使う */
export async function getPaymentStateForListing(
  db: Db,
  listingId: string,
): Promise<{ status: string; listingStatus: string | null } | null> {
  const rows = await db
    .select({ status: payments.status, listingStatus: listings.status })
    .from(payments)
    .leftJoin(listings, eq(listings.id, payments.listingId))
    .where(
      and(
        eq(payments.listingId, listingId),
        inArray(payments.status, ["created", "pending", "succeeded", "failed", "expired"]),
      ),
    )
    .orderBy(desc(payments.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 処理に失敗した Webhook の件数。
 *
 * ★失敗しても Stripe には 200 を返している。★ 同じ入力なら再送しても
 * 同じ失敗になるので、再送させ続けても意味がないという判断で、
 * 記録だけ残して 200 を返す設計にしてある（handleStripeEvent の catch）。
 *
 * ★その代わり、誰かが必ず見る場所に出す。★ ここを出さないと
 * 「110円は受け取ったが掲載が出ていない」が完全に不可視になる。
 * Stripe の画面では成功、こちらのログは流れて消える、利用者には
 * 何も届かない。実際にその状態を作ってしまった（2026-08-16）。
 */
export async function countFailedWebhookEvents(db: Db): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(paymentWebhookEvents)
    .where(eq(paymentWebhookEvents.status, "failed"));
  return rows[0]?.count ?? 0;
}
