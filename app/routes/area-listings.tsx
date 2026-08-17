import { Link } from "react-router";

import { SITE } from "~/config/site";
import { ListingGrid, SearchFilters } from "~/components/listing-grid";
import { Pagination } from "~/components/ui";
import { buildPageMeta } from "~/domain/seo";
import { buildPageHref } from "~/domain/list-params";
import { loadListPage, requireLocation } from "~/server/list-page.server";
import { listCities } from "~/server/repositories/location-repository.server";
import type { Route } from "./+types/area-listings";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext, params }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const db = context.getDb();
  const prefecture = await requireLocation(db, params.prefectureCode, "prefecture");

  const [data, cities] = await Promise.all([
    loadListPage({
      request,
      context,
      override: { prefectureCode: prefecture.code },
    }),
    listCities(db, prefecture.code),
  ]);

  return {
    ...data,
    prefecture: { code: prefecture.code, name: prefecture.name },
    cityLinks: cities.map((city) => ({ code: city.code, name: city.name })),
  };
}

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  if (!loaderData) return [{ title: SITE.name }];
  const suffix = loaderData.filters.page > 1 ? `（${loaderData.filters.page}ページ目）` : "";
  return buildPageMeta({
    title: `${loaderData.prefecture.name}の投稿${suffix} | ${SITE.name}`,
    description: `${loaderData.prefecture.name}で掲載中の投稿${loaderData.result.total}件。市区町村・カテゴリ・価格で絞り込めます。`,
    path:
      loaderData.filters.page > 1
        ? `/area/${loaderData.prefecture.code}?page=${loaderData.filters.page}`
        : `/area/${loaderData.prefecture.code}`,
    origin: loaderData.origin,
  });
}

export default function AreaListings({ loaderData }: Route.ComponentProps) {
  const { prefecture, cityLinks, result, prefectures, cities, filters } =
    loaderData;
  const basePath = `/area/${prefecture.code}`;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">
        {prefecture.name}の投稿
      </h1>

      {cityLinks.length > 0 ? (
        <nav aria-label="市区町村" className="mt-4">
          <ul className="flex flex-wrap gap-2">
            {cityLinks.map((city) => (
              <li key={city.code}>
                <Link
                  to={`/area/${prefecture.code}/${city.code}`}
                  className="inline-block rounded-lg border border-washi-300 bg-white px-3 py-2 text-sm hover:bg-washi-100"
                >
                  {city.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

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
        buildHref={(page) => buildPageHref(basePath, filters, page, ["pref"])}
      />
    </div>
  );
}
