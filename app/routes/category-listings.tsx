import { SITE } from "~/config/site";
import { ListingGrid, SearchFilters } from "~/components/listing-grid";
import { Pagination } from "~/components/ui";
import { CATEGORIES, isCategorySlug } from "~/domain/categories";
import { buildPageMeta } from "~/domain/seo";
import { notFound } from "~/server/errors";
import { buildPageHref } from "~/domain/list-params";
import { loadListPage } from "~/server/list-page.server";
import type { Route } from "./+types/category-listings";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext, params }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const slug = params.categorySlug;
  // 未知のカテゴリは 404。存在しない URL に 200 を返さない。
  if (!isCategorySlug(slug)) throw notFound(`unknown category: ${slug}`);

  const data = await loadListPage({
    request,
    context,
    override: { category: slug },
  });
  return { ...data, category: CATEGORIES[slug] };
}

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  if (!loaderData) return [{ title: SITE.name }];
  const { category, result, filters } = loaderData;
  const pageSuffix = filters.page > 1 ? `（${filters.page}ページ目）` : "";
  return buildPageMeta({
    title: `${category.name}${pageSuffix} | ${SITE.name}`,
    description: `${category.description} 現在${result.total}件を掲載中。地域や価格で絞り込めます。`,
    path: `/c/${category.slug}`,
    origin: loaderData.origin,
  });
}

export default function CategoryListings({ loaderData }: Route.ComponentProps) {
  const { category, result, prefectures, cities, filters } = loaderData;
  const basePath = `/c/${category.slug}`;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">{category.name}</h1>
      <p className="mt-2 text-washi-700">{category.description}</p>

      <SearchFilters
        action={basePath}
        prefectures={prefectures}
        cities={cities}
        filters={filters}
        lock={{ category: true }}
      />

      <p className="mt-6 text-sm text-washi-600" role="status">
        {result.total}件が見つかりました
      </p>
      <ListingGrid listings={result.items} />
      <Pagination
        page={result.page}
        totalPages={result.totalPages}
        buildHref={(page) => buildPageHref(basePath, filters, page, ["category"])}
      />
    </div>
  );
}
