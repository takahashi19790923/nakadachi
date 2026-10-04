import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";

import {
  categories,
  listingCategoryDetails,
  listings,
  payments,
  paymentWebhookEvents,
} from "~/db/schema/index.ts";
import { isCategorySlug, usesDirectInquiry } from "~/domain/categories";
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
import {
  assertCategoryAcceptingNew,
  flagPublishedListing,
  transitionListing,
} from "../listing-service.server.ts";
import { getSiteFlags, pausedError } from "../site-flags.server.ts";
import {
  notifyListingPublished,
  notifyPaymentFailed,
} from "../notification-service.server.ts";
import {
  createCheckoutSession,
  createRefund,
  expireCheckoutSession,
  retrieveCheckoutSession,
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

/**
 * Checkout Session の有効期間。放置された決済待ちを下書きへ戻す判断に使う。
 *
 * ★突き合わせ（reconcile-service）もこの値を見ている。★ Stripe は Session が
 * 切れた時点で必ず checkout.session.expired を送ってくるので、これを過ぎても
 * created のままの決済は「通知が1件も届いていない」ことの証拠になる。
 * ここを伸ばしたら検知の猶予も一緒に伸びる（別々に持たない）。
 */
export const SESSION_TTL_MINUTES = 60;

/**
 * 前回の支払いが払い終わっているときの案内。
 * 成立の通知の処理が失敗して止まった場合は待っても解けないので、問い合わせ先も書く。
 */
const CHECKOUT_IN_PROGRESS_MESSAGE =
  "お支払いの確認中です。反映まで数分お待ちください。お支払いがお済みの場合、もう一度お支払いいただく必要はありません。しばらくたっても反映されない場合は、お問い合わせください。";

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
}): Promise<CheckoutStartResult> {
  const { db, env, logger, listingId, userId } = options;

  // ★掲載の受付を止めているときは、決済にも進ませない。★
  const flags = await getSiteFlags(db);
  if (flags.listingsPaused) throw pausedError("listing", flags.notice);

  const rows = await db
    .select({
      id: listings.id,
      ownerId: listings.ownerId,
      status: listings.status,
      title: listings.title,
      durationDays: listings.durationDays,
      categorySlug: categories.slug,
      applyUrl: listingCategoryDetails.applyUrl,
      applyEmail: listingCategoryDetails.applyEmail,
    })
    .from(listings)
    .innerJoin(categories, eq(categories.id, listings.categoryId))
    .leftJoin(listingCategoryDetails, eq(listingCategoryDetails.listingId, listings.id))
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

  // ★受付を止めたカテゴリは、Stripe を呼ぶ前に止める。★ 下書きが残っていても払わせない。
  // 知らないカテゴリは素通りさせない（将来カテゴリを足したとき、決済だけ開いてしまわないように）。
  if (!isCategorySlug(listing.categorySlug)) {
    throw new AppError("conflict", "この投稿は決済に進める状態ではありません。", {
      detail: `unknown category at checkout: ${listing.categorySlug}`,
    });
  }
  assertCategoryAcceptingNew(listing.categorySlug);

  /*
   * ★応募の連絡先が無いお仕事は、払わせない。★ 公開しても応募の手段が無い掲載になる。
   * 連絡先の欄ができる前の下書きが残っていても、ここで止める（Stripe を呼ぶ前）。
   */
  if (usesDirectInquiry(listing.categorySlug) && !listing.applyUrl && !listing.applyEmail) {
    throw new AppError(
      "validation_failed",
      "応募の連絡先（応募ページの URL かメールアドレス）を入力してから、お支払いに進んでください。",
      { detail: `direct-inquiry listing without contact: ${listingId}` },
    );
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

  /*
   * ★前回の決済が «払い終わった» かを、新しい Session を作る前に Stripe に聞く。★（監査 PAY-01）
   *
   * 支払いの確認中の画面で待ちきれずにもう一度 «支払う» を押すと、前回の
   * Session はすでに完了（complete）していることがある。以前はそれを知らずに
   * 新しい Session を作り、前回を /expire しようとして 400 になり（完了した
   * Session は失効できない）、★それでも DB を expired にしていた。★ 後から届いた
   * 成立の通知は expired の行を成立にできず、110円を受け取ったのに掲載が出なかった。
   *
   * Stripe の Session の状態（API リファレンス、2026-10-03 確認）:
   *   open     … 進行中。支払いの処理はまだ始まっていない
   *   complete … 完了。支払いの処理は続いていることがある
   *   expired  … 期限切れ。これ以上何も起きない
   * /expire できるのは open だけ。
   *
   * ★聞けなかったら新しい Session を作らない（fail-closed）。★ 作ると、払い終わった
   * 決済の横に2本目の支払いリンクができる。止まるのは Stripe 側の障害中だけ。
   */
  const stillOpen: typeof openPayments = [];
  for (const open of openPayments) {
    const state = await readCheckoutStatus({
      secretKey: stripeSecretKey,
      sessionId: open.checkoutSessionId,
      logger,
      listingId,
    });
    if (state === "complete") {
      throw new AppError("conflict", CHECKOUT_IN_PROGRESS_MESSAGE, {
        detail: `previous checkout session is complete: payment=${open.id}`,
      });
    }
    /*
     * Stripe で切れている Session は、記録をここで閉じない（2026-10 のレビュー）。
     * 切れた時点で Stripe は失効の通知を送っており、その処理が記録を直す。
     * ここで先に閉じると、その通知が «こちらが閉じた決済» と見分けられて投稿に
     * 触れなくなり、新しい Session を作れなかったときに投稿が決済待ちのまま残る。
     * Stripe に無い（missing）ものは通知も来ないので、ここで閉じる。
     */
    if (state === "missing") {
      await markPaymentExpired(db, open.id);
      continue;
    }
    if (state === "expired") continue;
    stillOpen.push(open);
  }

  const paymentId = ulid();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000);

  const session = await createCheckoutSession({
    secretKey: stripeSecretKey,
    // ★ここが金額の唯一の出どころ。★
    amountJpy: LISTING_FEE_JPY,
    currency: LISTING_FEE_CURRENCY,
    productName: "投稿の掲載料",
    // 金額の文字も定数から組む（監査 FN-01。直書きは料金を変えたとき取り残される）。
    productDescription: `1件の掲載につき${LISTING_FEE_JPY.toLocaleString("ja-JP")}円（税込）。これ以外の料金はかかりません。`,
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
      // 記録用。★公開時の日数はここからは読まない。★ 行の duration_days が正
      // （transitionListing）。フォーム由来の値を信じていた頃の名残で、
      // Stripe の画面から「何日で売ったか」を追えるようにだけ残している。
      duration_days: String(listing.durationDays),
    },
    expiresAt,
    // 同じ要求の再送（通信のやり直し）で Session が二重にできるのを止める。
    // ★画面の連打は止めない。★ 押すたびに paymentId が新しいので鍵も変わる。
    // 連打で2本とも払われた場合は、突き合わせの duplicate_paid が拾う（監査 PAY-02）。
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
   * ★失効できなかったら、記録を expired にしない。★（監査 PAY-01）
   * 失効できないのは «上で open と聞いてから今までの間に払い終わった»
   * か «もう切れた» のどちらか。もう一度聞いて記録を合わせる。
   *  - expired … 記録も expired にする
   *  - complete … 払い終わっている。★新しい Session を使わせない。★ 新しい方を
   *    失効させ、利用者には «確認中» と返す（2本目を払わせない）。記録は
   *    そのまま残し、成立の通知で公開する
   *  - 聞けない … 記録はそのまま。成立の通知が来れば公開され、来なければ
   *    Stripe の期限で expired の通知が来る
   */
  for (const open of stillOpen) {
    try {
      await expireCheckoutSession({
        secretKey: stripeSecretKey,
        sessionId: open.checkoutSessionId,
      });
      await markPaymentExpired(db, open.id);
      continue;
    } catch (error) {
      logger.warn("failed to expire previous checkout session", {
        listingId,
        paymentId: open.id,
        detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }

    const state = await readCheckoutStatus({
      secretKey: stripeSecretKey,
      sessionId: open.checkoutSessionId,
      logger,
      listingId,
    }).catch(() => null);
    if (state === "expired" || state === "missing") {
      await markPaymentExpired(db, open.id);
      continue;
    }
    if (state === "complete") {
      // 前回が払い終わっていた。いま作った方を使わせない。
      // ★記録を先に閉じてから Stripe で失効させる。★ 失効の通知（実測220ms）が
      // 先に着くと «こちらが閉じた決済» と見分けられず、払った本人に失敗の通知が出る。
      await markPaymentExpired(db, paymentId);
      try {
        await expireCheckoutSession({ secretKey: stripeSecretKey, sessionId: session.id });
      } catch (expireError) {
        logger.error("failed to expire the new checkout session after a race", expireError, {
          listingId,
          paymentId,
        });
      }
      throw new AppError("conflict", CHECKOUT_IN_PROGRESS_MESSAGE, {
        detail: `previous checkout session completed during restart: payment=${open.id}`,
      });
    }
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

/**
 * Checkout Session の状態（open / complete / expired）を Stripe に聞く。
 *
 * ★聞けなければ例外にする（fail-closed）。★ 呼び出し側が «払い終わったか
 * 分からないまま新しい支払いリンクを作る» のを止めるため。
 */
async function readCheckoutStatus(options: {
  secretKey: string;
  sessionId: string;
  logger: Logger;
  listingId: string;
}): Promise<string> {
  try {
    const session = await retrieveCheckoutSession({
      secretKey: options.secretKey,
      sessionId: options.sessionId,
    });
    return session.status;
  } catch (error) {
    /*
     * ★Stripe に無い Session（404 resource_missing）は «切れている» として扱う。★
     * 鍵のアカウント違いやサンドボックスのリセットで起きる。払われることは無いのに、
     * 例外にすると «二度と払えない投稿» が残る（2026-10 のレビュー）。
     */
    const detail = error instanceof AppError ? (error.detail ?? "") : "";
    if (/status=404\b/.test(detail) && /code=resource_missing\b/.test(detail)) {
      options.logger.warn("checkout session not found at stripe; treating as gone", {
        listingId: options.listingId,
      });
      // «missing»: 失効の通知も来ないので、記録はこちらで閉じる（呼び出し側）。
      return "missing";
    }
    options.logger.error("failed to read checkout session status", error, {
      listingId: options.listingId,
    });
    throw new AppError(
      "payment_failed",
      "決済の状態を確認できませんでした。時間をおいてもう一度お試しください。",
      { detail: `checkout session status unavailable: ${options.sessionId}` },
    );
  }
}

/**
 * 決済の記録を expired にする。★まだ確定していない行だけ。★
 * 同時に成立の通知が来て succeeded にした行を、上から書き戻さない。
 */
async function markPaymentExpired(db: Db, paymentId: string): Promise<void> {
  await db
    .update(payments)
    .set({ status: "expired", updatedAt: new Date() })
    .where(and(eq(payments.id, paymentId), inArray(payments.status, ["created", "pending"])));
}

/**
 * 投稿の生きた支払いリンクを無効にする。決済待ちの投稿を削除・却下するときに呼ぶ。
 * （監査 FN-07・ADM-15）
 *
 * 以前は状態を変えるだけで Stripe の Session を残していたので、消した投稿の
 * 支払いリンクが期限まで払えた（消した投稿に110円）。
 *
 * 戻り値の paidInProgress は «払い終わった（complete）Session がある»。
 * 本人の削除ではこれを見て止める（払った直後に消させない）。管理者の却下・削除は
 * 止めない（運営の判断。払われていれば突き合わせの警報が拾い、規約第5条2項で返金）。
 *
 * ★Stripe に聞けなかった Session は «払われているかもしれない» として数える。★
 */
export async function cancelOpenCheckouts(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  listingId: string;
}): Promise<{ paidInProgress: boolean }> {
  const { db, env, logger, listingId } = options;
  const open = await db
    .select({ id: payments.id, checkoutSessionId: payments.checkoutSessionId })
    .from(payments)
    .where(and(eq(payments.listingId, listingId), inArray(payments.status, ["created", "pending"])));
  if (open.length === 0) return { paidInProgress: false };

  const secretKey = requireSecret(env, "STRIPE_SECRET_KEY");
  let paidInProgress = false;
  for (const row of open) {
    let state: string;
    try {
      state = await readCheckoutStatus({ secretKey, sessionId: row.checkoutSessionId, logger, listingId });
    } catch {
      paidInProgress = true;
      continue;
    }
    if (state === "complete") {
      paidInProgress = true;
      continue;
    }
    /*
     * ★記録を先に閉じてから Stripe で失効させる。★ 失効の通知（実測220ms）が
     * 先に着くと «こちらが閉じた決済» と見分けられず、消した本人に «お支払いを
     * 確認できませんでした» が届く。失効に失敗して実は払われていた場合も、
     * 成立の通知は expired の行を成立にできる（handleSessionSucceeded）。
     */
    await markPaymentExpired(db, row.id);
    if (state === "open") {
      try {
        await expireCheckoutSession({ secretKey, sessionId: row.checkoutSessionId });
      } catch (error) {
        // 聞いてから今までに払われた／切れた／通信の失敗。払われたものとして扱う（安全側）。
        logger.warn("failed to expire checkout session on cancel", {
          listingId,
          paymentId: row.id,
          detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        });
        paidInProgress = true;
        /*
         * ★切れたと確かめられなければ、記録を元に戻す。★（2026-10 のレビュー）
         * expired のまま残すと、もう一度 «削除» を押したときに対象から外れて削除が
         * 通る（払い終わっていたなら «払ったのに投稿が無い»）。通信の失敗で Session が
         * 生きていれば、次の «支払う» が2本目のリンクを作る。
         */
        const again = await readCheckoutStatus({
          secretKey,
          sessionId: row.checkoutSessionId,
          logger,
          listingId,
        }).catch(() => null);
        if (again !== "expired" && again !== "missing") {
          await db
            .update(payments)
            .set({ status: "created", updatedAt: new Date() })
            .where(and(eq(payments.id, row.id), eq(payments.status, "expired")));
        }
      }
    }
  }
  return { paidInProgress };
}

// ── Webhook ───────────────────────────────────────────────────────

export interface WebhookHandleResult {
  readonly status: "processed" | "duplicate" | "ignored" | "failed";
  readonly detail?: string;
}

/**
 * 応答を返したあとに回す処理の預け先。
 *
 * ★通知メールは決済の成否に関係ない。★ それでも応答の中で待っていたため、
 * Webhook の応答時間が平均2.7秒になっていた（2026-08-16、Stripe の
 * ダッシュボード実測）。メール1通で DB を2〜3往復し、さらに送信APIを叩く。
 * 決済事業者の再送判定は応答の速さも見るので、短いほうが安全でもある。
 *
 * 渡されなければその場で待つ。テストと定期処理はこちらを使う
 * （待たないと、送ったかどうかを確かめられない）。
 */
export type DeferFn = (promise: Promise<unknown>) => void;

function afterResponse(
  defer: DeferFn | undefined,
  task: () => Promise<void>,
): Promise<void> {
  const running = task();
  if (!defer) return running;
  defer(running);
  return Promise.resolve();
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
  /** 通知メールを応答の外へ出す。省略すると応答の中で待つ */
  defer?: DeferFn;
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
    /*
     * ★失敗した通知だけは、再送されたら処理し直す。★
     * 以前は一意制約で «処理済み» として飛ばしていたので、原因を直してから
     * Stripe のダッシュボードで再送しても処理されなかった（運用手順が効かない）。
     * 処理済み・処理中（received）は今までどおり飛ばす。どの処理も条件付きの
     * UPDATE で二重に効かない作りなので、やり直しても二重にはならない。
     */
    .onConflictDoUpdate({
      target: [paymentWebhookEvents.provider, paymentWebhookEvents.eventId],
      set: { status: "received", errorMessage: null, processedAt: null, updatedAt: new Date() },
      // 失敗したもの、または処理の途中で止まったもの（受け取ってから15分を過ぎても
      // received のまま。突き合わせの countFailedWebhooks と同じ基準）。
      setWhere: sql`${paymentWebhookEvents.status} = 'failed' or (${paymentWebhookEvents.status} = 'received' and ${paymentWebhookEvents.receivedAt} < now() - interval '15 minutes')`,
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

/**
 * Webhook の記録に、どの決済・投稿の通知だったかを書く（監査 MON-03）。
 * 以前は列があるのに一度も書いておらず、失敗した通知から対象を辿れなかった。
 * 記録用なので、失敗しても本処理は止めない。
 */
async function linkEvent(
  db: Db,
  eventId: string,
  refs: { paymentId: string; listingId: string | null },
): Promise<void> {
  await db
    .update(paymentWebhookEvents)
    .set({ paymentId: refs.paymentId, listingId: refs.listingId, updatedAt: new Date() })
    .where(eq(paymentWebhookEvents.eventId, eventId))
    .catch(() => undefined);
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
  defer?: DeferFn;
}): Promise<void> {
  const { db, env, logger, event } = options;
  const session = event.data.object;

  const sessionId = readString(session, "id");
  if (!sessionId) throw new Error("session id missing");

  const paymentStatus = readString(session, "payment_status");
  if (paymentStatus !== "paid") {
    // 後払いの手段では completed でも未入金のことがある。確認中で止める。
    // ★確定済み（succeeded・返金・係争）の行は pending に戻さない。★（監査 PAY-04）
    // 通知の到着順は Stripe の都合で決まる。戻すと、その後の返金で掲載が止まらない。
    await db
      .update(payments)
      .set({ status: "pending", updatedAt: new Date() })
      .where(
        and(
          eq(payments.checkoutSessionId, sessionId),
          inArray(payments.status, ["created", "expired"]),
        ),
      );

    const pendingRow = await findLinkedPaymentBySession(db, sessionId);
    if (pendingRow) {
      const moved = await transitionListing(db, {
        listingId: pendingRow.listingId,
        to: "payment_processing",
        actor: "system",
        expectedFrom: "payment_pending",
      });
      // 決済待ち以外から来た場合は動かない。あとで支払い成立の通知が
      // 届けばそこで公開されるので実害は無いが、黙って流さない。
      if (!moved.changed && moved.from !== "payment_processing") {
        logger.warn("listing did not move to payment_processing", {
          listingId: pendingRow.listingId,
          listingStatus: moved.from,
        });
      }
    }
    logger.info("checkout completed but not paid yet", { sessionId });
    return;
  }

  const amountTotal = session.amount_total;
  const currency = readString(session, "currency");

  const raw = await findPaymentBySession(db, sessionId);
  // 参照が外れていても、どの決済の通知だったかは記録に残す（失敗した通知から辿れるように）。
  if (raw) await linkEvent(db, event.id, { paymentId: raw.id, listingId: raw.listingId });
  const payment = await findLinkedPaymentBySession(db, sessionId);
  if (!payment) {
    // 自分のアカウント宛でない、記録が消えている、または投稿・利用者の参照が
    // 外れている（退会・180日の削除）。公開しない。
    throw new Error(`no payment row for session ${sessionId}`);
  }

  const metadata = readMetadata(session);

  if (
    !isValidListingFeePayment(
      typeof amountTotal === "number" ? amountTotal : null,
      currency,
    ) ||
    // 設定の EXPECTED_CURRENCY とも突き合わせる（監査 E-7-1。以前は何にも使われていなかった）。
    // 設定が無い環境で成立の通知が全部落ちないよう、無ければ定数で照合する。
    currency?.toLowerCase() !== (env.EXPECTED_CURRENCY ?? LISTING_FEE_CURRENCY).toLowerCase()
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

  /*
   * ★返金・係争が確定している決済で公開しない。★
   *
   * イベントの到着順は決済事業者側の都合で決まる。返金が先に確定したあとで
   * 支払い成立の通知が届くことがありうる（後払いの決済を返金した場合など）。
   * 下の公開処理は draft からの公開も許すので、ここで止めないと
   * ★返金済みなのに掲載が出る。★ 掲載料を返したのに掲載が続く状態は、
   * 決済事業者側にもアプリのエラーにも出ないので誰も気づけない。
   *
   * 例外にして Webhook を失敗として記録する。管理画面の先頭に件数が出る。
   */
  if (
    payment.status === "refunded" ||
    payment.status === "partially_refunded" ||
    payment.status === "disputed"
  ) {
    logger.error(
      "payment already refunded or disputed; refusing to publish",
      new Error("refund precedes payment success"),
      { listingId: payment.listingId, paymentId: payment.id, status: payment.status },
    );
    throw new AppError("conflict", "掲載を公開できませんでした。", {
      detail: `refunded payment cannot publish: listing=${payment.listingId} status=${payment.status}`,
    });
  }

  const paymentIntentId = readString(session, "payment_intent");

  // ★決済記録と公開を同じトランザクションで更新する。★
  // 片方だけ成立すると「課金したのに公開されない」「無料で公開された」になる。
  let published = false;
  await db.transaction(async (tx) => {
    /*
     * ★状態を WHERE に入れる。★ 上の返金済み判定は少し前に読んだ写しを
     * 見ている。その直後に charge.refunded が別のイベントとして着いて
     * refunded に変えていると、ここで無条件に succeeded を書き戻し、
     * 返金したのに公開する。返金の側は条件付き UPDATE で守ってあるので、
     * こちらも同じ形にする。当たらなければ「もう別の状態へ進んだ」で止める。
     * すでに succeeded（同じ支払いの別イベント）は通す。冪等に公開済みを
     * 確かめる下のループが受け止める。
     *
     * ★expired も通す。★（監査 PAY-01 の二重の守り）Stripe が «払われた» と
     * 言っている以上、こちらの記録が expired でもお金は受け取っている。
     * 以前の版が払い終わった Session を expired と記録していた行や、
     * 失効の通知と成立の通知の行き違いでも、掲載は必ず出す。
     */
    const claimed = await tx
      .update(payments)
      .set({
        status: "succeeded",
        paidAt: new Date(),
        paymentIntentId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(payments.id, payment.id),
          inArray(payments.status, ["created", "pending", "succeeded", "expired"]),
        ),
      );
    if ((claimed.rowCount ?? 0) === 0) {
      throw new AppError("conflict", "掲載を公開できませんでした。", {
        detail: `payment moved to a terminal state before publish: ${payment.id}`,
      });
    }

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
        // 日数は渡さない。行の duration_days を transitionListing が読む。
        // metadata.duration_days は記録用で、公開の判断には使わない。
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

  /*
   * ★要確認の語（severity=flag）を含む掲載を、管理者の確認待ちに入れる。★
   *
   * 2026-08-28 まで findFlaggedWords はどこからも呼ばれておらず、
   * ★flag として登録された語は検知しても何も起きなかった★
   * （本番に6件あった）。登録した側は「見張られている」と思っていた。
   *
   * ★公開された時点で作る。★ 下書きの段階では作らない。管理者は
   * 他人の下書きを見られない（assertOwner は管理者も通さない）ので、
   * 見られないものを指す通報を作っても行き止まりになる。
   *
   * 公開そのものは止めない。flag は「通したうえで確認する」ための印。
   * ★ここが失敗しても決済と公開は巻き戻さない。★ お金は受け取っていて
   * 掲載も出ている。通報が作れなかったことはログに残す。
   */
  await afterResponse(options.defer, () =>
    flagPublishedListing({ db, logger, listingId: payment.listingId }),
  );

  // ★メールの失敗で公開を巻き戻さない。★ 冪等キーがあるので、あとから
  // 同じ鍵で再送しても二重には届かない。応答の外へ出す（afterResponse）。
  await afterResponse(options.defer, () =>
    notifyListingPublished({
      db,
      env,
      logger,
      listingId: payment.listingId,
      userId: payment.userId,
    }).catch((error: unknown) => {
      logger.error("publish notification failed", error, {
        listingId: payment.listingId,
      });
    }),
  );

  logger.info("listing published after payment", {
    listingId: payment.listingId,
  });
}

/**
 * Session ID から決済記録を引く。
 *
 * ★参照が外れた行（listing_id / user_id が null）も返す。★（監査 PAY-03）
 * 退会や、掲載終了から180日の物理削除で投稿・利用者の参照は外れるが、
 * 決済の記録は7年残す帳簿。以前はここで null を返していたので、その後の
 * 失効・返金・係争が «他サービスの決済» として無視され、帳簿が実態と食い違った。
 * 投稿に触る処理は呼び出し側で listingId の有無を見る。
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
  return rows[0] ?? null;
}

/**
 * 公開・通知に使う版。★投稿と利用者の両方に結び付いた行だけを返す。★
 * 消えた投稿を公開しようとして落ちないように。
 */
async function findLinkedPaymentBySession(db: Db, sessionId: string) {
  const row = await findPaymentBySession(db, sessionId);
  if (!row?.listingId || !row.userId) return null;
  return { ...row, listingId: row.listingId, userId: row.userId };
}

/** payment_intent から引く版。★参照が外れた行も返す★（監査 PAY-03） */
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
  return rows[0] ?? null;
}

/** 決済の失敗・失効。投稿は下書きへ戻す（再課金は発生しない） */
async function handleSessionFailed(
  options: { db: Db; env: AppEnv; logger: Logger; event: StripeEvent; defer?: DeferFn },
  reason: string,
): Promise<void> {
  const { db, event } = options;
  // env と logger は下の通知でオプション経由で使う。
  const sessionId = readString(event.data.object, "id");
  if (!sessionId) throw new Error("session id missing");

  const payment = await findPaymentBySession(db, sessionId);
  if (!payment) return;
  await linkEvent(db, event.id, { paymentId: payment.id, listingId: payment.listingId });
  if (payment.status === "succeeded") {
    // 支払い済みの Session に対する失効通知は無視する。
    return;
  }
  /*
   * ★こちらが自分で閉じた決済の失効通知では、投稿にも利用者にも触れない。★
   * やり直し・削除・却下で /expire すると、Stripe は直後（実測220ms）に失効の
   * 通知を送ってくる。それを «決済が失効した» と扱うと、払ったばかりの本人や
   * 投稿を消した本人に «お支払いを確認できませんでした» が届き、投稿が下書きへ
   * 戻ることがあった（2026-10 のレビュー）。行はすでに expired / failed なので見分けられる。
   */
  const closedByUs = payment.status === "expired" || payment.status === "failed";

  await db
    .update(payments)
    .set({
      status: reason === "session_expired" ? "expired" : "failed",
      failureCode: reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(payments.id, payment.id),
        // 確定済みの行（成立・返金・係争）を失効・失敗で上書きしない。
        inArray(payments.status, ["created", "pending", "expired"]),
      ),
    );

  // 投稿・利用者の参照が外れた決済は、記録を合わせるだけ（監査 PAY-03）。
  const listingId = payment.listingId;
  const userId = payment.userId;
  if (!listingId || !userId) return;
  if (closedByUs) {
    options.logger.info("ignored failure notice for a checkout we closed", {
      listingId,
      paymentId: payment.id,
      reason,
    });
    return;
  }

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
        eq(payments.listingId, listingId),
        gt(payments.id, payment.id),
      ),
    )
    .limit(1);

  if (newer.length > 0) {
    options.logger.info("ignored superseded checkout failure", {
      listingId,
      paymentId: payment.id,
      reason,
    });
    return;
  }

  let reverted = false;
  for (const from of ["payment_pending", "payment_processing"] as const) {
    const result = await transitionListing(db, {
      listingId,
      to: "draft",
      actor: "system",
      expectedFrom: from,
    });
    if (result.changed) {
      reverted = true;
      break;
    }
  }
  // ★下書きに戻せなかった（削除・却下・公開済み）なら、«下書きとして残っています» の
  // 通知は送らない。★ 事実と食い違う（2026-10 のレビュー、監査 FN-12 の型）。
  if (!reverted) return;

  await afterResponse(options.defer, () =>
    notifyPaymentFailed({
      db,
      env: options.env,
      logger: options.logger,
      listingId,
      userId,
      attempt: payment.id,
    }).catch((error: unknown) => {
      options.logger.error("payment failure notification failed", error);
    }),
  );
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
  await linkEvent(db, event.id, { paymentId: payment.id, listingId: payment.listingId });

  if (payment.status === "refunded" || payment.status === "disputed") {
    // すでに確定している。無駄な処理を省くための先読みで、これは
    // 二重処理を防ぐ「保証」ではない（下の条件付き UPDATE が保証する）。
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

  /*
   * ★確定は条件付き UPDATE で行う。★ 上の先読みだけでは足りない。
   *
   * 1回の返金で Stripe は3通送ってくる（refund.created / refund.updated /
   * charge.refunded）。event_id が違うので Webhook の重複判定では弾けず、
   * ★3通が同時に走ると、どれもまだ succeeded を読んで全部が処理へ進む。★
   * 実際に監査ログと通知が二重に出た（2026-08-16、preview）。
   *
   * 「まだ確定していない状態のときだけ更新する」を SQL の条件に入れ、
   * 更新できた1通だけが先へ進む。
   */
  const claimed = await db
    .update(payments)
    .set({
      status: isFullRefund ? "refunded" : "partially_refunded",
      refundedAmountJpy: refundedAmount,
      refundedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(payments.id, payment.id),
        inArray(payments.status, ["succeeded", "partially_refunded"]),
      ),
    );

  if ((claimed.rowCount ?? 0) === 0) {
    // 別のイベントが先に確定させた。監査ログも通知も重ねない。
    return;
  }

  if (!isFullRefund) return;

  const listingId = payment.listingId;
  if (!listingId) {
    // ★投稿の参照が外れた決済の返金も、帳簿には残す。★（監査 PAY-03）
    // 止める掲載はもう無い。監査ログは決済を対象にして書く。
    await writeAuditLog(db, env, {
      action: "payment.refunded",
      actorId: payment.userId,
      actorRole: "system",
      targetType: "payment",
      targetId: payment.id,
      metadata: { refundedAmountJpy: refundedAmount },
    });
    logger.info("refund recorded for a detached payment", { paymentId: payment.id });
    return;
  }

  /*
   * ★二重払いの片方の返金では、投稿を止めない。★
   * 同じ投稿にほかの成立した支払いが残っていれば、掲載料は払われている。
   * 止めると、二重払いを返金しただけで掲載が消える（突き合わせの duplicate_paid の対応）。
   */
  const otherPaid = await db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.listingId, listingId),
        eq(payments.status, "succeeded"),
        ne(payments.id, payment.id),
      ),
    )
    .limit(1);
  if (otherPaid.length > 0) {
    await writeAuditLog(db, env, {
      action: "payment.refunded",
      actorId: payment.userId,
      actorRole: "system",
      targetType: "listing",
      targetId: listingId,
      metadata: { refundedAmountJpy: refundedAmount, duplicate: "true" },
    });
    logger.info("refund of a duplicate payment; listing stays published", {
      listingId,
      paymentId: payment.id,
    });
    return;
  }

  // ★返金したのに掲載が続く状態を作らない。★
  const suspended = await transitionListing(db, {
    listingId,
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
    targetId: listingId,
    metadata: { refundedAmountJpy: refundedAmount },
  });

  /*
   * ★止めていないのに「止めた」と書かない。★
   *
   * expectedFrom が合わないと transitionListing は例外を投げず
   * changed:false を返す。以前はこの戻り値を見ずに
   * 「listing suspended after full refund」を必ず出していたので、
   * ★公開されていない投稿の返金でも「停止した」と記録されていた。★
   * 実際に、下書きの投稿で2回そう出た（2026-08-16、preview）。
   * 運用でログを見る人が、止まっていないものを止まったと読む。
   */
  if (suspended.changed) {
    logger.warn("listing suspended after full refund", { listingId });
    return;
  }

  if (suspended.from === "suspended" || suspended.from === "deleted") {
    // すでに止まっている・消えている。返金と矛盾しない。
    return;
  }

  /*
   * 公開前（下書き・決済待ち・確認中）の返金。掲載は出ていないので
   * 実害は無いが、この後に支払い成立の通知が来ると公開されうる。
   * その経路は handleSessionSucceeded 側で塞いである。
   * ★記録は残す。★ 返金と掲載の状態が食い違う唯一の入口なので。
   */
  logger.warn("refund on a listing that was not published", {
    listingId,
    listingStatus: suspended.from,
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
  await linkEvent(db, event.id, { paymentId: payment.id, listingId: payment.listingId });

  /*
   * 返金済みの上には書かない。返金が確定したあとに申し立てが届くことは
   * ある（利用者が返金前にカード会社へ連絡していた場合）。無条件に
   * disputed で上書きすると、返金の記録が状態から消え、突き合わせ
   * （refunded_but_live）の対象からも外れる。
   */
  await db
    .update(payments)
    .set({ status: "disputed", updatedAt: new Date() })
    .where(
      and(
        eq(payments.id, payment.id),
        inArray(payments.status, ["created", "pending", "succeeded", "partially_refunded"]),
      ),
    );

  const listingId = payment.listingId;
  if (!listingId) {
    // ★投稿の参照が外れた決済の係争も、帳簿には残す。★（監査 PAY-03）
    await writeAuditLog(db, env, {
      action: "payment.disputed",
      actorRole: "system",
      targetType: "payment",
      targetId: payment.id,
    });
    options.logger.warn("dispute recorded for a detached payment", { paymentId: payment.id });
    return;
  }

  const suspended = await transitionListing(db, {
    listingId,
    to: "suspended",
    actor: "system",
    expectedFrom: "published",
    moderationReason: "決済に関する申し立てがあったため、掲載を停止しました。",
  });

  await writeAuditLog(db, env, {
    action: "payment.disputed",
    actorRole: "system",
    targetType: "listing",
    targetId: listingId,
  });

  /*
   * ★止められなかったことを黙って流さない。★
   * 申し立ては入金ごと取り上げられる話なので、掲載が残っているかどうかは
   * 必ず分かるようにする。expectedFrom が合わないと transitionListing は
   * 例外を投げず changed:false を返すだけなので、見ないと素通りする。
   * （返金・公開で同じ穴を踏んでいる。2026-08-16）
   */
  if (suspended.changed) {
    options.logger.warn("listing suspended after dispute", { listingId });
  } else if (suspended.from !== "suspended" && suspended.from !== "deleted") {
    options.logger.error(
      "dispute could not stop the listing",
      new Error("suspend transition did not apply"),
      { listingId, listingStatus: suspended.from },
    );
  }
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

  const refund = await createRefund({
    secretKey: requireSecret(env, "STRIPE_SECRET_KEY"),
    paymentIntentId: payment.paymentIntentId,
    amountJpy: payment.amountJpy,
    idempotencyKey: `refund:${paymentId}`,
  });

  /*
   * ★返金の要求が通っても、返金が失敗していることがある。★（監査 PAY-05）
   * Stripe は 200 で refund を返し、その status が failed / canceled のことがある。
   * 見ないと «返金した» つもりで終わる。管理画面に失敗として返す。
   */
  if (refund.status === "failed" || refund.status === "canceled") {
    options.logger.error("refund was not accepted by stripe", new Error(`refund status=${refund.status}`), {
      paymentId,
    });
    throw new AppError("payment_failed", "返金が完了しませんでした。Stripe のダッシュボードで状況を確かめてください。", {
      detail: `refund ${refund.id} status=${refund.status}`,
    });
  }

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
    /*
     * ★«いちばん進んだ» 決済を見る。★ 以前は最新の1行だったので、払い終わった1本目の
     * 後にこちらが閉じた2本目（expired）を拾い、払った本人に «お支払いを確認できません
     * でした» と出ていた（2026-10 のレビュー）。成立 → 確認中・作成済み → 失敗・失効 の順。
     */
    .orderBy(
      sql`case ${payments.status} when 'succeeded' then 0 when 'pending' then 1 when 'created' then 1 else 2 end`,
      desc(payments.createdAt),
    )
    .limit(1);
  return rows[0] ?? null;
}

/*
 * 処理に失敗した Webhook の件数を数えるのは reconcile-service へ移した。
 * 管理画面と毎時の警報が同じ数を見るようにするため、実装は1つに保つ。
 */
