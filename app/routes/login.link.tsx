import { redirect } from "react-router";

import { safeRedirectPath } from "~/domain/validation/common";
import { expireCookie } from "~/server/cookies.server";
import { createSession } from "~/server/session.server";
import { verifyLoginLink } from "~/server/services/auth-service.server";
import { LOGIN_EMAIL_COOKIE } from "./login";
import type { Route } from "./+types/login.link";
import { getApp } from "~/server/app-context";

/**
 * メールのリンクからのログイン。
 *
 * ★GET で状態が変わる（セッションが作られる）唯一の経路。★
 * メールのリンクを踏むという操作の性質上こうならざるを得ないが、
 * トークンは一度使えば無効になるので、先読みや転送で二重に使われても
 * 2回目は必ず失敗する。
 */
export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const next = safeRedirectPath(url.searchParams.get("next"));

  if (!token) {
    throw redirect("/login/error?reason=missing_token");
  }

  try {
    const { user } = await verifyLoginLink({
      db: context.getDb(),
      env: context.env,
      logger: context.logger,
      request,
      token,
    });

    const { setCookie } = await createSession({
      db: context.getDb(),
      env: context.env,
      userId: user.id,
      request,
    });

    const headers = new Headers();
    headers.append("set-cookie", setCookie);
    headers.append(
      "set-cookie",
      expireCookie(LOGIN_EMAIL_COOKIE, {
        secure: context.env.APP_ORIGIN.startsWith("https://"),
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
      }),
    );

    return redirect(next, { headers });
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.warn("magic link verification failed");
    // ★失敗の理由を細かく出さない。★ 有効なトークンの形が推測できてしまう。
    throw redirect("/login/error?reason=invalid_token");
  }
}

export default function LoginLink() {
  // ローダーが必ず転送するので、ここは描かれない。
  return null;
}
