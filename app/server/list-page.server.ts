import type { CategorySlug } from "~/domain/categories";
import { PER_PAGE, type ListFilters } from "~/domain/list-params";
import { parseSearchParams } from "~/domain/validation/interaction";
import type { AppContext } from "./app-context.ts";
import type { Db } from "./db.server.ts";
import { notFound } from "./errors.ts";
import {
  searchListings,
  type ListingSearchResult,
} from "./repositories/listing-repository.server.ts";
import {
  getLocation,
  listCities,
  listPrefectures,
} from "./repositories/location-repository.server.ts";

export interface ListPageData {
  readonly result: ListingSearchResult;
  readonly prefectures: { code: string; name: string }[];
  readonly cities: { code: string; name: string }[];
  readonly filters: ListFilters;
  readonly origin: string;
}

/**
 * 一覧・検索ページの共通ローダー。
 *
 * カテゴリ別・地域別・キーワード検索は、絞り込みの初期値が違うだけで
 * 中身は同じ。1か所にまとめて、公開判定や並べ替えの実装がずれないようにする。
 *
 * ★ページ送りの URL 組み立て（buildPageHref）は domain/list-params.ts にある。★
 * 画面側の部品からも呼ぶため、サーバー専用モジュールには置けない。
 */
export async function loadListPage(options: {
  request: Request;
  context: AppContext;
  /** URL のパスから決まる絞り込み。クエリより優先する */
  override?: {
    category?: CategorySlug;
    prefectureCode?: string;
    cityCode?: string;
  };
}): Promise<ListPageData> {
  const { request, context } = options;
  const db: Db = context.getDb();
  const url = new URL(request.url);
  const query = parseSearchParams(url);

  const prefectureCode = options.override?.prefectureCode ?? query.pref;
  const cityCode = options.override?.cityCode ?? query.city;
  const category = options.override?.category ?? query.category;

  const [result, prefectures, cities] = await Promise.all([
    searchListings(db, {
      categorySlug: category,
      kind: query.kind,
      prefectureCode,
      cityCode,
      keyword: query.q,
      minPriceJpy: query.min,
      maxPriceJpy: query.max,
      sort: query.sort,
      page: query.page,
      perPage: PER_PAGE,
    }),
    listPrefectures(db),
    prefectureCode ? listCities(db, prefectureCode) : Promise.resolve([]),
  ]);

  return {
    result,
    prefectures: prefectures.map((row) => ({ code: row.code, name: row.name })),
    cities: cities.map((row) => ({ code: row.code, name: row.name })),
    filters: {
      q: query.q,
      category,
      kind: query.kind,
      pref: prefectureCode,
      city: cityCode,
      min: query.min,
      max: query.max,
      sort: query.sort,
      page: query.page,
    },
    origin: context.env.APP_ORIGIN,
  };
}

/** 地域ページ。存在しないコードなら 404（当て推量での探索を許さない） */
export async function requireLocation(
  db: Db,
  code: string,
  kind: "prefecture" | "city",
) {
  const location = await getLocation(db, code);
  if (!location || location.kind !== kind) {
    throw notFound(`location not found: ${code}`);
  }
  return location;
}
