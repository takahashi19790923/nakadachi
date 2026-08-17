import { Link } from "react-router";

import { SITE } from "~/config/site";
import { CATEGORY_LIST } from "~/domain/categories";
import { LISTING_FEE_JPY, formatJpy } from "~/domain/pricing";
import { ListingCard } from "~/components/listing-card";
import { buildPageMeta } from "~/domain/seo";
import { listRecentPublished } from "~/server/repositories/listing-repository.server";
import { listPrefectures } from "~/server/repositories/location-repository.server";
import type { Route } from "./+types/home";
import { getApp } from "~/server/app-context";

export async function loader({ context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const db = context.getDb();
  const [recent, prefectures] = await Promise.all([
    listRecentPublished(db, { limit: 12 }),
    listPrefectures(db),
  ]);
  return { recent, prefectures, origin: context.env.APP_ORIGIN };
}

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return buildPageMeta({
    title: `${SITE.name} | ${SITE.tagline}`,
    description: SITE.description,
    path: "/",
    origin: loaderData?.origin,
  });
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { recent, prefectures } = loaderData;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <section className="rounded-2xl bg-ai-800 px-6 py-10 text-white">
        <h1 className="text-2xl font-bold leading-snug sm:text-3xl">
          {SITE.tagline}
        </h1>
        <p className="mt-3 max-w-2xl text-ai-100">{SITE.description}</p>
        <p className="mt-4 inline-block rounded-lg bg-ai-900/60 px-3 py-2 text-sm">
          閲覧・会員登録は無料。掲載時のみ1件
          <strong className="mx-1">{formatJpy(LISTING_FEE_JPY)}</strong>（税込）
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link to="/search" className="btn btn-secondary">
            地域から探す
          </Link>
          <Link to="/listings/new" className="btn btn-accent">
            投稿してみる
          </Link>
        </div>
      </section>

      <section className="mt-10" aria-labelledby="categories-heading">
        <h2 id="categories-heading" className="text-lg font-bold text-washi-900">
          カテゴリから探す
        </h2>
        <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CATEGORY_LIST.map((category) => (
            <li key={category.slug}>
              <Link
                to={`/c/${category.slug}`}
                className="card block h-full p-4 hover:border-ai-300 hover:bg-ai-50"
              >
                <p className="font-semibold text-ai-900">{category.name}</p>
                <p className="mt-1 text-sm text-washi-600">
                  {category.description}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10" aria-labelledby="recent-heading">
        <h2 id="recent-heading" className="text-lg font-bold text-washi-900">
          新着の投稿
        </h2>
        {recent.length === 0 ? (
          <p className="card mt-4 p-6 text-center text-washi-600">
            まだ公開中の投稿がありません。
            <Link to="/listings/new" className="link ml-1">
              最初の投稿をしてみませんか
            </Link>
          </p>
        ) : (
          <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recent.map((listing, index) => (
              <li key={listing.id}>
                <ListingCard listing={listing} priority={index < 3} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10" aria-labelledby="area-heading">
        <h2 id="area-heading" className="text-lg font-bold text-washi-900">
          地域から探す
        </h2>
        <ul className="mt-4 flex flex-wrap gap-2">
          {prefectures.map((prefecture) => (
            <li key={prefecture.code}>
              <Link
                to={`/area/${prefecture.code}`}
                className="inline-block rounded-lg border border-washi-300 bg-white px-3 py-2 text-sm hover:bg-washi-100"
              >
                {prefecture.name}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
