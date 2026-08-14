import type { Route } from "./+types/robots[.]txt";
import { getApp } from "~/server/app-context";

/**
 * robots.txt
 *
 * ★Cloudflare の既定では Content-Type が text/html になり、sitemap も
 * 伝わらない。★ 自前で配る。
 *
 * 個人の活動が辿れる画面（マイページ・管理画面・決済まわり）は
 * 明示的に外す。ただし robots.txt は「お願い」でしかないので、
 * ★これに頼らず noindex とアクセス制御の両方を必ず入れる。★
 */
export function loader({ context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const origin = context.env.APP_ORIGIN;

  /*
   * ★本番以外は丸ごと拒否する。★
   * preview は本番とほぼ同じ内容を別のホスト名で配る。索引に入ると、
   * 同じ投稿が2つの URL で並び、検索結果に preview のほうが出ることがある。
   * 投稿者から見れば「知らないドメインに自分の掲載が載っている」状態になる。
   * sitemap も出さない（出すとクローラーに拾わせる口を自分で開けることになる）。
   */
  if (context.env.ENVIRONMENT !== "production") {
    return new Response(
      ["User-agent: *", "Disallow: /", ""].join("\n"),
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const lines = [
    "User-agent: *",
    "Allow: /",
    "",
    "# 個人の活動が辿れる画面",
    "Disallow: /mypage",
    "Disallow: /admin",
    "Disallow: /login",
    "Disallow: /logout",
    "",
    "# 条件の組み合わせだけ違う薄いページ",
    "Disallow: /search",
    "",
    "# 公開前・決済中の投稿",
    "Disallow: /listings/new",
    "Disallow: /listings/*/edit",
    "Disallow: /listings/*/confirm",
    "Disallow: /listings/*/checkout",
    "Disallow: /listings/*/pending",
    "Disallow: /listings/*/images",
    "Disallow: /listings/*/report",
    "Disallow: /listings/*/contact",
    "",
    "# 機械向けの口",
    "Disallow: /api/",
    "",
    `Sitemap: ${new URL("/sitemap.xml", origin).toString()}`,
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
