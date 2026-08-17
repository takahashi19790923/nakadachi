import type { CategorySlug } from "./categories";

/**
 * 一覧・検索の絞り込み条件と、URL の組み立て。
 *
 * ★依存を持たない専用ファイルにしている。★ ページ送りの部品（クライアント側）が
 * この関数を使うため、サーバー専用モジュールに置くとブラウザ側バンドルへ
 * DB ドライバごと引き込まれ、ビルドが落ちる。
 */

/** 1ページの件数。増やすと初期表示が重くなる */
export const PER_PAGE = 24;

export interface ListFilters {
  q?: string;
  category?: CategorySlug;
  kind?: string;
  pref?: string;
  city?: string;
  min?: number;
  max?: number;
  sort: string;
  page: number;
}

/** パスで固定される条件。ページ送りの URL でクエリに重ねない */
export type PathLockedFilter = "category" | "pref" | "city";

/**
 * 現在の絞り込みを保ったまま、ページ番号だけを変えた URL を作る。
 *
 * ★カテゴリ・地域もクエリへ入れる。★ ただし basePath に含まれているもの
 * （/c/:slug のカテゴリ、/area/:code の地域）は locked で除く。
 * 以前は「カテゴリと地域は basePath 側に含まれる」と決め打ちして
 * 一切入れていなかったので、★/search?category=job&pref=13 の2ページ目が
 * 全件の2ページ目になり、見出しの件数だけが絞り込み後のまま★だった
 * （2026-08-17 の点検で発覚）。
 */
export function buildPageHref(
  basePath: string,
  filters: ListFilters,
  page: number,
  locked: readonly PathLockedFilter[] = [],
): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.category && !locked.includes("category")) {
    params.set("category", filters.category);
  }
  if (filters.pref && !locked.includes("pref")) params.set("pref", filters.pref);
  if (filters.city && !locked.includes("city")) params.set("city", filters.city);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.min !== undefined) params.set("min", String(filters.min));
  if (filters.max !== undefined) params.set("max", String(filters.max));
  if (filters.sort !== "newest") params.set("sort", filters.sort);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}
