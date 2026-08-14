import { SITE } from "~/config/site";
import { ListingGrid, SearchFilters } from "~/components/listing-grid";
import { Pagination } from "~/components/ui";
import { buildPageMeta } from "~/domain/seo";
import { buildPageHref } from "~/domain/list-params";
import { loadListPage } from "~/server/list-page.server";
import type { Route } from "./+types/search";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  return loadListPage({ request, context });
}

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  const keyword = loaderData?.filters.q;
  return buildPageMeta({
    title: keyword
      ? `「${keyword}」の検索結果 | ${SITE.name}`
      : `投稿をさがす | ${SITE.name}`,
    description:
      "地域・カテゴリ・投稿種別・価格帯・キーワードで、掲載中の投稿を探せます。閲覧は無料です。",
    path: "/search",
    origin: loaderData?.origin,
    // ★検索結果ページは索引させない。★ 同じ内容のページが条件の組み合わせだけ
    // 生まれ、薄い重複ページとして扱われる。入口はカテゴリ別・地域別にする。
    noindex: true,
  });
}

export default function Search({ loaderData }: Route.ComponentProps) {
  const { result, prefectures, cities, filters } = loaderData;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">投稿をさがす</h1>

      <SearchFilters
        action="/search"
        prefectures={prefectures}
        cities={cities}
        filters={filters}
      />

      <p className="mt-6 text-sm text-washi-600" role="status">
        {result.total}件が見つかりました
      </p>
      <ListingGrid listings={result.items} />
      <Pagination
        page={result.page}
        totalPages={result.totalPages}
        buildHref={(page) => buildPageHref("/search", filters, page)}
      />
    </div>
  );
}
