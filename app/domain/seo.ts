import type { MetaDescriptor } from "react-router";

import { DEFAULT_OG_IMAGE_PATH, SITE } from "~/config/site";

/**
 * ページの meta を組み立てる。
 *
 * ★このファイルはサーバー専用モジュールを import しないこと。★
 * React Router がルートから取り除くのは loader / action / middleware /
 * headers だけで、meta はクライアント側のバンドルにも入る。ここから
 * *.server.ts を辿ると、DB ドライバごとブラウザへ運ぼうとしてビルドが落ちる
 * （落ちずに通ってしまうより、落ちてくれるほうがずっとよい）。
 *
 * ★公開中の投稿以外は必ず noindex にする。★ 下書き・決済待ち・マイページ・
 * 管理画面が検索結果に出ると、個人の活動が第三者から辿れてしまう。
 *
 * ★OGP に個人情報を入れないこと。★ 説明文は投稿の本文から作るので、
 * 利用者が本文へ電話番号を書けばそれが OGP に載る。投稿フォームで注意を
 * 出したうえで、抽出時にも連絡先らしき文字列を落とす。
 */
export function buildPageMeta(options: {
  title: string;
  description: string;
  path: string;
  origin?: string;
  noindex?: boolean;
  ogImagePath?: string;
  ogType?: "website" | "article";
}): MetaDescriptor[] {
  const origin = options.origin ?? SITE.canonicalOrigin;
  const canonical = new URL(options.path, origin).toString();
  const image = new URL(
    options.ogImagePath ?? DEFAULT_OG_IMAGE_PATH,
    origin,
  ).toString();

  const descriptors: MetaDescriptor[] = [
    { title: options.title },
    { name: "description", content: options.description },
    { tagName: "link", rel: "canonical", href: canonical },
    { property: "og:site_name", content: SITE.name },
    { property: "og:type", content: options.ogType ?? "website" },
    { property: "og:title", content: options.title },
    { property: "og:description", content: options.description },
    { property: "og:url", content: canonical },
    { property: "og:image", content: image },
    { property: "og:locale", content: "ja_JP" },
    { name: "twitter:card", content: "summary_large_image" },
  ];

  if (options.noindex) {
    descriptors.push({ name: "robots", content: "noindex, nofollow" });
  }

  return descriptors;
}

/** ログイン後の画面で使う。中身に関わらず検索エンジンへ載せない */
export function privatePageMeta(title: string): MetaDescriptor[] {
  return [
    { title: `${title} | ${SITE.name}` },
    { name: "robots", content: "noindex, nofollow" },
    // 参照元に画面のURLを渡さない（マイページのパスに ID が入るため）
    { name: "referrer", content: "no-referrer" },
  ];
}

/** 連絡先らしき文字列を落とす。OGP と meta description に載せないため */
export function stripContactInfo(text: string): string {
  return text
    .replace(/[0-9０-９][0-9０-９\-‐−ー()（） ]{8,}[0-9０-９]/g, "［連絡先］")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "［連絡先］");
}

/**
 * 説明文の材料。
 * 改行と連続空白を潰し、長すぎる場合は末尾を丸める。
 */
export function toMetaDescription(body: string, maxLength = 110): string {
  const flat = stripContactInfo(body).replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) return flat;
  return `${flat.slice(0, maxLength - 1)}…`;
}
