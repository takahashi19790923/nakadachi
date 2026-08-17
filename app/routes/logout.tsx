import { redirect } from "react-router";

import { clearGateCookie } from "~/server/admin-gate.server";
import { assertCsrf } from "~/server/csrf.server";
import { destroySession } from "~/server/session.server";
import type { Route } from "./+types/logout";
import { getApp } from "~/server/app-context";

/**
 * ログアウト。
 *
 * ★POST だけを受ける。★ GET にすると、他サイトの <img src="/logout"> や
 * ブラウザの先読みで勝手にログアウトさせられる。
 *
 * ★Cookie を消すだけでは足りない。★ DB 側のセッションも失効させる。
 * Cookie の値を控えられていた場合、消すだけでは使い続けられる。
 */
export async function action({ request, context: rawContext }: Route.ActionArgs) {
  const context = getApp(rawContext);
  // ★他の状態変更と同じ二重の照合（Origin ＋ 署名付きトークン）。★
  // ここだけ Origin 照合のみだったので、設計上の穴として1か所残っていた。
  await assertCsrf(request, context.env, await request.formData());

  const { setCookie } = await destroySession({
    db: context.getDb(),
    env: context.env,
    request,
  });

  const headers = new Headers();
  headers.append("set-cookie", setCookie);
  // 管理画面の通過証も同時に捨てる。
  headers.append("set-cookie", clearGateCookie(context.env));

  return redirect("/", { headers });
}

export function loader() {
  // GET で来たら、ただトップへ戻す（状態は変えない）。
  throw redirect("/");
}
