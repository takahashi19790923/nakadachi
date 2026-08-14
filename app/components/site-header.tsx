import { Form, Link, NavLink } from "react-router";

import { CATEGORY_LIST } from "~/domain/categories";
import { SITE } from "~/config/site";

interface Props {
  user: { id: string; role: "user" | "admin" } | null;
}

export function SiteHeader({ user }: Props) {
  return (
    <header className="border-b border-washi-200 bg-white">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-3">
        <Link
          to="/"
          className="flex items-center gap-2 text-ai-800 hover:text-ai-900 sm:gap-3"
        >
          {/*
            ★alt を空にする。★ 隣に同じ意味の文字（サービス名）があるので、
            読み上げが「なかだち なかだち」と二重になる。装飾として扱う。

            ★width/height を必ず書く。★ 読み込み前の場所が確保されず、
            画像が来た瞬間に見出しやボタンが下へずれる（CLS）。
            fetchPriority=high なのは、全ページの最上部に出る唯一の画像のため。
          */}
          <img
            src="/brand-header.jpg"
            alt=""
            width={320}
            height={213}
            fetchPriority="high"
            className="h-12 w-auto rounded-md sm:h-[4.5rem]"
          />
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-xl font-bold tracking-tight">{SITE.name}</span>
            <span className="hidden text-xs font-medium text-washi-500 sm:inline">
              {SITE.tagline}
            </span>
          </span>
        </Link>

        <div className="ml-auto flex items-center gap-2">
          <Link to="/search" className="btn btn-secondary px-3 py-2 text-sm">
            さがす
          </Link>
          {user ? (
            <>
              <Link to="/mypage" className="btn btn-secondary px-3 py-2 text-sm">
                マイページ
              </Link>
              <Link to="/listings/new" className="btn btn-accent px-3 py-2 text-sm">
                投稿する
              </Link>
              {user.role === "admin" ? (
                <Link to="/admin" className="btn btn-secondary px-3 py-2 text-sm">
                  管理
                </Link>
              ) : null}
              {/*
                ログアウトはリンクではなくフォームにする。GET で状態を変えると、
                先読みやブラウザの拡張が勝手に踏んでログアウトさせられる。
              */}
              <Form method="post" action="/logout">
                <button type="submit" className="btn btn-secondary px-3 py-2 text-sm">
                  ログアウト
                </button>
              </Form>
            </>
          ) : (
            <>
              <Link to="/login" className="btn btn-secondary px-3 py-2 text-sm">
                ログイン
              </Link>
              <Link to="/listings/new" className="btn btn-accent px-3 py-2 text-sm">
                投稿する
              </Link>
            </>
          )}
        </div>
      </div>

      <nav aria-label="カテゴリ" className="border-t border-washi-100">
        <ul className="mx-auto flex w-full max-w-5xl gap-1 overflow-x-auto px-2 py-1 text-sm">
          {CATEGORY_LIST.map((category) => (
            <li key={category.slug}>
              <NavLink
                to={`/c/${category.slug}`}
                className={({ isActive }) =>
                  [
                    "block whitespace-nowrap rounded px-3 py-2 font-medium",
                    isActive
                      ? "bg-ai-100 text-ai-900"
                      : "text-washi-700 hover:bg-washi-100",
                  ].join(" ")
                }
              >
                {category.name}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
