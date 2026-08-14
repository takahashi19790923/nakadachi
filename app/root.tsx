import { useContext } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import { NonceContext } from "./nonce";

import type { Route } from "./+types/root";
import "./app.css";
import { SiteFooter } from "./components/site-footer";
import { SiteHeader } from "./components/site-header";
import { SITE } from "./config/site";
import { loadUser } from "./server/guards.server";
import { getApp } from "~/server/app-context";
import { isAppError } from "~/server/errors";
/**
 * 全画面で必要な値をここで1回だけ用意する。
 *
 * ★このローダーは例外を投げないこと。★ ここが落ちると Layout が
 * loaderData なしで描かれ、nonce が空になる。すると CSP がすべての
 * スクリプトを止め、「画面は出るがボタンだけ反応しない」状態になる。
 * ★curl では 200 が返り、文言もマークアップも正しく見えるので気づけない。★
 */
export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  let user: { id: string; role: "user" | "admin" } | null = null;
  try {
    const session = await loadUser({ request, context });
    user = session ? { id: session.id, role: session.role } : null;
  } catch (error) {
    // DB が落ちていてもサイトの骨組みは出す。ログインしていない扱いにする。
    context.logger.error("root loader: failed to resolve session", error);
  }

  return {
    nonce: context.nonce,
    csrfToken: context.csrfToken,
    user,
    turnstileSiteKey: context.env.TURNSTILE_SITE_KEY,
    appOrigin: context.env.APP_ORIGIN,
  };
}

export type RootLoaderData = Awaited<ReturnType<typeof loader>>;

/** 子ルートから root のデータを読むための入口 */
export function useRootData(): RootLoaderData | undefined {
  return useRouteLoaderData<RootLoaderData>("root");
}

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  { rel: "manifest", href: "/site.webmanifest" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<RootLoaderData>("root");
  // ★nonce はローダーのデータからではなくコンテキストから取る。★
  // Layout は loaderData が無い場面（エラー画面など）でも描かれる。
  // 空のまま <Scripts> を出すと CSP が全スクリプトを止め、
  // 「見た目は正常なのにボタンだけ反応しない」状態になる。詳細は app/nonce.ts。
  const nonce = useContext(NonceContext);

  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#2d4b5e" />
        <Meta />
        <Links />
      </head>
      <body className="flex min-h-dvh flex-col">
        {/* キーボードだけで操作する人が、毎回ヘッダーを通らずに済むようにする */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-4 focus:py-2 focus:shadow"
        >
          本文へ移動
        </a>
        <SiteHeader user={data?.user ?? null} />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * エラー画面。
 * ★スタックトレースを本番で出さない。★ 内部のファイル構成と依存が漏れる。
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "問題が発生しました";
  let description =
    "時間をおいてもう一度お試しください。解決しない場合はお問い合わせください。";
  let status = 500;

  if (isRouteErrorResponse(error)) {
    status = error.status;
    if (error.status === 404) {
      title = "ページが見つかりません";
      description =
        "アドレスが変わったか、掲載が終了した可能性があります。トップから探し直してください。";
    } else if (error.status === 403) {
      title = "この操作は行えません";
      description = "権限をご確認のうえ、もう一度お試しください。";
    } else if (error.status === 429) {
      title = "しばらくお待ちください";
      description =
        "短い時間に操作が続きました。少し時間をおいてからお試しください。";
    } else if (error.statusText) {
      description = error.statusText;
    }
  } else if (isAppError(error)) {
    // SSR のときだけここへ来る（AppError はクライアントへ渡る途中で
    // 伏せられる）。画面に出す番号と、実際に返している番号をそろえる。
    status = error.status;
    description = error.message;
  }

  const stack =
    import.meta.env.DEV && error instanceof Error ? error.stack : undefined;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16">
      <p className="text-sm font-semibold text-washi-500">エラー {status}</p>
      <h1 className="mt-2 text-2xl font-bold text-washi-900">{title}</h1>
      <p className="mt-4 text-washi-700">{description}</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <a className="btn btn-primary" href="/">
          トップページへ
        </a>
        <a className="btn btn-secondary" href="/contact">
          お問い合わせ
        </a>
      </div>
      {stack ? (
        <pre className="mt-8 overflow-x-auto rounded bg-washi-100 p-4 text-xs">
          <code>{stack}</code>
        </pre>
      ) : null}
      <p className="mt-8 text-sm text-washi-500">
        {SITE.name}（{SITE.nameLatin}）
      </p>
    </div>
  );
}
