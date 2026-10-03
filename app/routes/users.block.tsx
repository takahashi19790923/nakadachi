import { redirect } from "react-router";

import { isUlid } from "~/domain/ulid";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { asRouteError, notFound } from "~/server/errors";
import { requireUser } from "~/server/guards.server";
import { setBlock } from "~/server/services/engagement-service.server";
import { safeRedirectPath } from "~/domain/validation/common";
import type { Route } from "./+types/users.block";
import { getApp } from "~/server/app-context";

/**
 * 利用者のブロック。
 * ★ブロックしたことを相手に知らせない。★ 通知も、画面上の変化も出さない。
 */
export async function action({ request, context: rawContext, params }: Route.ActionArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  if (!isUlid(params.userId)) throw notFound("malformed id");

  const formData = await request.formData();
  try {
    assertSameOrigin(request, context.env);
    await verifyCsrfToken(
      context.env,
      formData.get("_csrf"),
      readCookie(request, csrfCookieName(context.env)),
    );

    await setBlock({
      db: context.getDb(),
      blockerId: user.id,
      blockedId: params.userId,
      intent: formData.get("intent") === "unblock" ? "unblock" : "block",
    });
  } catch (error) {
    // CSRF の照合に落ちた・自分自身を指定した、を 500 にしない（asRouteError の説明）。
    throw asRouteError(error);
  }

  return redirect(safeRedirectPath(formData.get("next"), "/mypage/messages"));
}

export function loader() {
  throw redirect("/mypage/messages");
}
