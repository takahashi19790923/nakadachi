import type { EntryContext, RouterContextProvider } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";

import { NonceContext } from "./nonce";
import { appContext } from "./server/app-context";
import { isAppError } from "./server/errors";

export const streamTimeout = 5_000;

/**
 * ErrorBoundary へ届いた AppError を、正しい HTTP ステータスで返すための保険。
 *
 * ★本番では効かない。開発中だけ。★（監査 AUTH-08）
 * 本番の React Router は、ここへ渡す前に Response 以外の例外を
 * «Unexpected Server Error» に置き換える（server-runtime の sanitizeErrors）。
 * isAppError が真になるのは開発中だけで、本番では 500 のまま返っていた。
 * 本番で正しい番号を返すには、loader・action の外へ AppError を漏らさない
 * （try/catch で受けて画面に出すか、errors.ts の asRouteError で包んで投げる）。
 */
function resolveStatus(routerContext: EntryContext, fallback: number): number {
  const errors: unknown = routerContext.staticHandlerContext.errors;
  if (!errors || typeof errors !== "object") return fallback;
  for (const error of Object.values(errors)) {
    if (isAppError(error)) return error.status;
  }
  return fallback;
}

/**
 * SSR の入口。
 *
 * 既定の実装に対して、★CSP の nonce を React コンテキストで配る★ 一点だけを
 * 足している。ローダーのデータ経由にすると、Layout で受け取れない場面があり、
 * その瞬間に全スクリプトが CSP で止まる（e2e/hydration.spec.ts が見張っている）。
 */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  responseStatusCode = resolveStatus(routerContext, responseStatusCode);

  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  // 設定が壊れていても描画自体は続けられるよう、取得に失敗したら空にする。
  // 空なら CSP がスクリプトを止めるので、壊れていることは必ず表面化する。
  let nonce: string;
  try {
    nonce = loadContext.get(appContext).nonce;
  } catch {
    nonce = "";
  }

  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <NonceContext.Provider value={nonce}>
      {/*
        ★ServerRouter にも nonce を渡すこと。★
        <Scripts> が出す最初のスクリプトとは別に、ストリーミングの途中で
        データを流し込むインライン script が出る。そちらは ServerRouter が
        書き出すので、ここで渡さないと nonce が付かず CSP に止められる。
        止まってもシェルは描画済みなので、★画面は正常に見えるのに
        ハイドレーションだけが起きない★という形になる。
      */}
      <ServerRouter context={routerContext} url={request.url} nonce={nonce} />
    </NonceContext.Provider>,
    {
      // React が自分で差し込むブートストラップ用スクリプトにも nonce を付ける。
      nonce,
      signal: AbortSignal.timeout(streamTimeout + 1000),
      onError(error: unknown) {
        responseStatusCode = 500;
        // シェルの描画中に出たエラーは handleDocumentRequest 側で記録されるので、
        // ここではストリーミング中のものだけを出す。
        if (shellRendered) {
          console.error(error);
        }
      },
    },
  );
  shellRendered = true;

  // 検索エンジンのクローラーには、全部そろってから返す。
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
