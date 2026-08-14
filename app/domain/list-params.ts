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

/**
 * 現在の絞り込みを保ったまま、ページ番号だけを変えた URL を作る。
 * パスで固定されている条件（カテゴリ・地域）は basePath 側に含まれるので、
 * クエリには入れない。
 */
export function buildPageHref(
  basePath: string,
  filters: ListFilters,
  page: number,
): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.min !== undefined) params.set("min", String(filters.min));
  if (filters.max !== undefined) params.set("max", String(filters.max));
  if (filters.sort !== "newest") params.set("sort", filters.sort);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}
