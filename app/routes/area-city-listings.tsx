import { Link } from "react-router";

import { SITE } from "~/config/site";
import { ListingGrid, SearchFilters } from "~/components/listing-grid";
import { Pagination } from "~/components/ui";
import { buildPageMeta } from "~/domain/seo";
import { notFound } from "~/server/errors";
import { buildPageHref } from "~/domain/list-params";
import { loadListPage, requireLocation } from "~/server/list-page.server";
import type { Route } from "./+types/area-city-listings";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext, params }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const db = context.getDb();
  /*
   * 都道府県と市区町村は互いを必要としない（親子の確認は下で行う）。
   * 順に待つと DB を1往復ぶん余計に使う。実測で1往復 100〜250ms。
   */
  const [prefecture, city] = await Promise.all([
    requireLocation(db, params.prefectureCode, "prefecture"),
    requireLocation(db, params.cityCode, "city"),
  ]);

  // ★親子関係を確かめる。★ 確かめないと、実在するコードの組み合わせを
  // 適当に並べた URL がすべて 200 を返し、同じ内容のページが量産される。
  if (city.parentCode !== prefecture.code) {
    throw notFound(`city ${city.code} is not in prefecture ${prefecture.code}`);
  }

  const data = await loadListPage({
    request,
    context,
    override: { prefectureCode: prefecture.code, cityCode: city.code },
  });

  return {
    ...data,
    prefecture: { code: prefecture.code, name: prefecture.name },
    city: { code: city.code, name: city.name },
  };
}

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  if (!loaderData) return [{ title: SITE.name }];
  const suffix = loaderData.filters.page > 1 ? `（${loaderData.filters.page}ページ目）` : "";
  return buildPageMeta({
    title: `${loaderData.prefecture.name}${loaderData.city.name}の投稿${suffix} | ${SITE.name}`,
    description: `${loaderData.prefecture.name}${loaderData.city.name}で掲載中の投稿${loaderData.result.total}件。`,
    path: `/area/${loaderData.prefecture.code}/${loaderData.city.code}`,
    origin: loaderData.origin,
  });
}

export default function AreaCityListings({ loaderData }: Route.ComponentProps) {
  const { prefecture, city, result, prefectures, cities, filters } = loaderData;
  const basePath = `/area/${prefecture.code}/${city.code}`;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <nav aria-label="パンくず" className="text-sm text-washi-600">
        <Link to={`/area/${prefecture.code}`} className="link">
          {prefecture.name}
        </Link>
        <span aria-hidden="true"> ／ </span>
        <span>{city.name}</span>
      </nav>

      <h1 className="mt-2 text-2xl font-bold text-washi-900">
        {prefecture.name}
        {city.name}の投稿
      </h1>

      <SearchFilters
        action={basePath}
        prefectures={prefectures}
        cities={cities}
        filters={filters}
        lock={{ area: true }}
      />

      <p className="mt-6 text-sm text-washi-600" role="status">
        {result.total}件が見つかりました
      </p>
      <ListingGrid listings={result.items} />
      <Pagination
        page={result.page}
        totalPages={result.totalPages}
        buildHref={(page) => buildPageHref(basePath, filters, page, ["pref", "city"])}
      />
    </div>
  );
}
