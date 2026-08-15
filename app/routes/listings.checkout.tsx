import { useEffect } from "react";
import { redirect } from "react-router";

import { LISTING_DURATION_DAYS_DEFAULT } from "~/domain/pricing";
import { isUlid } from "~/domain/ulid";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { notFound, toPublicError } from "~/server/errors";
import { requireUser } from "~/server/guards.server";
import { enforceRateLimit } from "~/server/rate-limit.server";
import { recordAccess } from "~/server/services/access-record-service.server";
import { startListingCheckout } from "~/server/services/payment/payment-service.server";
import type { Route } from "./+types/listings.checkout";
import { getApp } from "~/server/app-context";

/**
 * 決済の開始。
 *
 * ★POST だけを受ける。★ GET にすると、リンクを踏ませるだけで
 * 決済セッションを作らせられる。
 *
 * ★金額はクライアントから受け取らない。★ フォームが送るのは掲載期間だけで、
 * 110円という金額はサーバー側の定数から組み立てる。
 */
export async function action({ request, context: rawContext, params }: Route.ActionArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  if (!isUlid(params.listingId)) throw notFound("malformed id");

  const formData = await request.formData();

  try {
    assertSameOrigin(request, context.env);
    await verifyCsrfToken(
      context.env,
      formData.get("_csrf"),
      readCookie(request, csrfCookieName(context.env)),
    );
    await enforceRateLimit(context.getDb(), "checkoutCreate", user.id);

    const rawDuration = Number(formData.get("durationDays"));
    const durationDays = Number.isFinite(rawDuration)
      ? rawDuration
      : LISTING_DURATION_DAYS_DEFAULT;

    const { redirectUrl } = await startListingCheckout({
      db: context.getDb(),
      env: context.env,
      logger: context.logger,
      request,
      listingId: params.listingId,
      userId: user.id,
      durationDays,
    });

    /*
     * ★発信者情報はここで記録する。★
     * 実際に公開されるのは Stripe の Webhook を受けたときだが、あの経路の
     * 接続元は Stripe であって投稿者ではない。あそこで記録すると
     * 「全部の投稿が Stripe のIPから行われた」という無意味な記録になる。
     * 掲載を出す意思を示したこの瞬間が、投稿者本人の接続である。
     */
    await recordAccess({
      db: context.getDb(),
      env: context.env,
      logger: context.logger,
      request,
      action: "listing_published",
      userId: user.id,
      targetType: "listing",
      targetId: params.listingId,
    });

    /*
     * ★redirect() を返さない。★ 行き先が外部（checkout.stripe.com）だから。
     *
     * React Router の <Form> は fetch で送信し、応答のリダイレクトを自分で
     * 処理する。行き先が外部だと fetch が 302 を透過的に追ってしまい、
     * クライアントには「リダイレクトが起きた」ことが伝わらない。
     * ★ボタンを押しても何も起きない。★ 例外もコンソールの出力も無い。
     *
     * reloadDocument で素のフォーム送信にする手もあるが、そちらは
     * React Router が「forwarded action request」として弾く場合がある
     * （文書遷移の POST では origin ヘッダが null になることがあるため）。
     *
     * URL を返して画面側で window.location.assign する。
     * どちらの経路でも確実に移動できる。（2026-08-15 に実機で確認）
     */
    return { redirectUrl, message: null as string | null };
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.error("checkout start failed", error, {
      listingId: params.listingId,
    });
    const publicError = toPublicError(error);
    return {
      message: publicError.message,
    };
  }
}

export function loader({ params }: Route.LoaderArgs) {
  // GET では何もしない。確認画面へ戻す。
  throw redirect(`/listings/${params.listingId}/confirm`);
}

export default function Checkout({ actionData }: Route.ComponentProps) {
  const redirectUrl = actionData && "redirectUrl" in actionData
    ? actionData.redirectUrl
    : null;

  /*
   * ★決済画面への移動はここで行う。★ action の redirect() ではない。
   * 理由は action 側のコメントに書いた。
   *
   * useEffect にしているのは、描画中に副作用を起こさないため。
   * 移動できなかった場合に備えて、下にリンクも出しておく。
   */
  useEffect(() => {
    if (redirectUrl) window.location.assign(redirectUrl);
  }, [redirectUrl]);

  if (redirectUrl) {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-10">
        <h1 className="text-xl font-bold text-washi-900">
          お支払い画面へ移動しています
        </h1>
        <p className="mt-4 text-washi-700">
          切り替わらない場合は、
          <a href={redirectUrl} className="link mx-1">
            こちらから進んでください
          </a>
          。
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <h1 className="text-xl font-bold text-washi-900">
        決済手続きを開始できませんでした
      </h1>
      <p className="mt-4 text-washi-700">
        {actionData?.message ??
          "時間をおいてもう一度お試しください。料金は請求されていません。"}
      </p>
    </div>
  );
}
