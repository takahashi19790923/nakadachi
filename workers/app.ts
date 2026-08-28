import { createRequestHandler, RouterContextProvider } from "react-router";

import { ulid } from "~/domain/ulid.ts";
import { appContext } from "~/server/app-context.ts";
import { readCookie, serializeCookie } from "~/server/cookies.server.ts";
import { runScheduledTasks } from "~/server/cron.server.ts";
import {
  csrfCookieName,
  csrfSignature,
  issueCsrfToken,
} from "~/server/csrf.server.ts";
import { createRequestDb } from "~/server/db.server.ts";
import { toAppEnv, type AppEnv } from "~/server/env.server.ts";
import { handleHealthCheck } from "~/server/health.server.ts";
import { createLogger } from "~/server/logger.server.ts";
import {
  applySecurityHeaders,
  generateNonce,
} from "~/server/security-headers.server.ts";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

/**
 * 本番ドメイン以外で同じ内容が見える状態を無くす。
 *
 * Workers は routes に custom_domain を書くと workers.dev のルートを
 * 自動で無効化するので、通常はここに来ない。それでも残しているのは、
 * 設定を変えた瞬間に「同じ内容が2つのホストで見える」状態へ戻るのを
 * 防ぐため（Turnstile の hostname 照合が効かないホストが増える）。
 *
 * GET/HEAD は 301、それ以外は 308。301 だと POST が GET に化けて本文が消える。
 */
function canonicalRedirect(request: Request, env: AppEnv): Response | null {
  const url = new URL(request.url);
  const canonical = new URL(env.APP_ORIGIN);
  if (url.host === canonical.host) return null;
  // ローカル開発（127.0.0.1 と localhost の行き来）では転送しない。
  if (env.ENVIRONMENT === "development") return null;

  const target = new URL(url.pathname + url.search, canonical);
  const status = request.method === "GET" || request.method === "HEAD" ? 301 : 308;
  return new Response(null, {
    status,
    headers: { location: target.toString(), "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, cloudflareEnv, ctx) {
    const requestId = ulid();
    let env: AppEnv;
    try {
      env = toAppEnv(cloudflareEnv);
    } catch {
      // 設定が壊れている状態で内部の詳細を返さない。
      return new Response("Service Unavailable", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }

    const logger = createLogger({ requestId, environment: env.ENVIRONMENT });

    const redirect = canonicalRedirect(request, env);
    if (redirect) return redirect;

    const { getDb, dispose } = createRequestDb(env);
    const nonce = generateNonce();

    /*
     * 応答後に続ける処理の預かり先。
     *
     * ★ここを通さずに ctx.waitUntil へ直接渡してはいけない。★
     * 下の finally が dispose() も waitUntil で走らせるため、両者が同時に
     * 進み、★接続を畳んだあとにクエリが飛ぶことがある。★
     * ローカル（miniflare）では再現せず、本番で時々失敗する形になる。
     * 預かったものが全部片づいてから畳む。
     */
    const deferred: Promise<unknown>[] = [];
    const defer = (promise: Promise<unknown>) => {
      // 失敗で Worker ごと落とさない。中身の記録は呼び出し側の責任。
      deferred.push(promise.catch(() => undefined));
    };

    /*
     * 応答に足す Set-Cookie。いまはセッションの期限延長だけが使う。
     * ★ローダーの戻り値では足せない。★ 延長はどの画面でも «読んだついでに»
     * 起きるので、画面ごとに Response を組み立て直す形にできない。
     */
    const extraCookies: string[] = [];
    const setCookie = (value: string): void => {
      extraCookies.push(value);
    };

    // CSRF の対（Cookie 側の乱数とフォームへ埋める署名付きトークン）を
    // ここで1回だけ用意する。各ローダーが個別に発行すると、同じ画面の中で
    // 別々の値が出て、後から描かれたフォームだけが通らなくなる。
    let csrfToken: string;
    let csrfSetCookie: string | null = null;
    try {
      const existing = readCookie(request, csrfCookieName(env));
      if (existing) {
        csrfToken = `${existing}.${await csrfSignature(env, existing)}`;
      } else {
        const issued = await issueCsrfToken(env);
        csrfToken = issued.token;
        csrfSetCookie = serializeCookie(csrfCookieName(env), issued.cookieValue, {
          secure: env.APP_ORIGIN.startsWith("https://"),
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
        });
      }
    } catch {
      // SESSION_SECRET が未投入の場合。状態を変える操作は verifyCsrfToken 側で
      // 必ず落ちるので、ここでは画面を出させる。
      csrfToken = "";
    }

    try {
      // 監視用。認証不要・副作用なし・軽い。React Router を通さずに答える。
      const url = new URL(request.url);
      if (url.pathname === "/api/health") {
        return await handleHealthCheck({ env, getDb, logger });
      }

      // React Router 8 では context が RouterContextProvider になった。
      // 素のオブジェクトを渡す書き方は使えないので、鍵に値を入れて渡す。
      const routerContext = new RouterContextProvider();
      routerContext.set(appContext, {
        env,
        ctx,
        defer,
        getDb,
        logger,
        nonce,
        requestId,
        csrfToken,
        setCookie,
      });

      const response = await requestHandler(request, routerContext);

      const secured = applySecurityHeaders(response, env, nonce);
      if (csrfSetCookie) secured.headers.append("set-cookie", csrfSetCookie);
      // セッションの期限延長など、処理の途中で足された Cookie。
      for (const cookie of extraCookies) {
        secured.headers.append("set-cookie", cookie);
      }
      return secured;
    } catch (error) {
      logger.error("unhandled request error", error, {
        path: new URL(request.url).pathname,
        method: request.method,
      });
      // ★スタックトレースを画面に出さない。★
      return applySecurityHeaders(
        new Response("Internal Server Error", {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
        env,
        nonce,
      );
    } finally {
      /*
       * 応答を返したあとに接続を畳む。ここで await すると応答が遅れる。
       * ★預かった後処理が終わるのを待ってから畳む。★ 先に畳むと、
       * 後処理のクエリが閉じた接続へ飛ぶ（本番で時々だけ失敗する形になる）。
       */
      ctx.waitUntil(
        (deferred.length > 0 ? Promise.allSettled(deferred) : Promise.resolve())
          .then(() => dispose()),
      );
    }
  },

  /**
   * 定期処理。wrangler.jsonc の triggers.crons から呼ばれる。
   *
   * ★ここに置いた理由。★ 以前は Node のスクリプト（scripts/cron.ts）に
   * 書いてあったが、`~/` 別名を使うモジュールを読めず起動すらしなかった。
   * 起動する設定もどこにも無く、★退会の30日後の削除も、発信者情報の
   * 183日での削除も1度も走っていなかった。★（2026-08-16 に発覚）
   *
   * Worker 側なら別名がビルドで解決され、R2 の binding も使えるので
   * 画像の物理削除まで1か所で完結する。CI に DB の接続文字列を置く必要もない。
   *
   * ★ここでは応答が無いので defer を使わない。★ 全部待ってから畳む。
   */
  async scheduled(controller, cfEnv, ctx) {
    const env = toAppEnv(cfEnv);
    const requestId = ulid();
    const logger = createLogger({ requestId, environment: env.ENVIRONMENT });
    const { getDb, dispose } = createRequestDb(env);

    try {
      await runScheduledTasks({
        cron: controller.cron,
        db: getDb(),
        env,
        logger,
      });
    } catch (error) {
      // 個々の処理は runScheduledTasks の中で捕まえてある。ここへ来るのは
      // DB へ繋げないなど、全部に共通する失敗のとき。
      logger.error("scheduled run failed", error, { cron: controller.cron });
    } finally {
      ctx.waitUntil(dispose());
    }
  },
} satisfies ExportedHandler<Env>;
