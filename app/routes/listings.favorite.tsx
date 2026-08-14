import { redirect } from "react-router";

import { isUlid } from "~/domain/ulid";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { notFound } from "~/server/errors";
import { requireUser } from "~/server/guards.server";
import { toggleFavorite } from "~/server/services/engagement-service.server";
import type { Route } from "./+types/listings.favorite";
import { getApp } from "~/server/app-context";

/**
 * お気に入りの切り替え。
 * ★POST のみ。★ GET にすると、他サイトの画像タグやブラウザの先読みで
 * 勝手に登録・解除される。
 */
export async function action({ request, context: rawContext, params }: Route.ActionArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  if (!isUlid(params.listingId)) throw notFound("malformed id");

  const formData = await request.formData();
  assertSameOrigin(request, context.env);
  await verifyCsrfToken(
    context.env,
    formData.get("_csrf"),
    readCookie(request, csrfCookieName(context.env)),
  );

  const intent = formData.get("intent") === "remove" ? "remove" : "add";
  await toggleFavorite({
    db: context.getDb(),
    userId: user.id,
    listingId: params.listingId,
    desired: intent,
  });

  // 元の画面へ戻す。戻り先はパスだけを受け付ける（オープンリダイレクト対策）。
  return redirect(`/listings/${params.listingId}`);
}

export function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/listings/${params.listingId}`);
}
