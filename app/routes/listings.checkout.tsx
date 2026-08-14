import { redirect } from "react-router";

import { LISTING_DURATION_DAYS_DEFAULT } from "~/domain/pricing";
import { isUlid } from "~/domain/ulid";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { notFound, toPublicError } from "~/server/errors";
import { requireUser } from "~/server/guards.server";
import { enforceRateLimit } from "~/server/rate-limit.server";
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

    // Stripe の決済画面へ。ここでは何も公開しない。
    return redirect(redirectUrl);
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
