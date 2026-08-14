import { Link } from "react-router";

import { SITE } from "~/config/site";
import { CATEGORY_LIST, LISTING_KIND_LABEL } from "~/domain/categories";
import { buildPageMeta } from "~/domain/seo";
import type { Route } from "./+types/categories";
import { getApp } from "~/server/app-context";

export function loader({ context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  return { origin: context.env.APP_ORIGIN };
}

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return buildPageMeta({
    title: `カテゴリ一覧 | ${SITE.name}`,
    description:
      "売ります・買います、あげます・譲ります、貸します、手伝います・教えます、お仕事の5つのカテゴリから探せます。",
    path: "/categories",
    origin: loaderData?.origin,
  });
}

export default function Categories() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">カテゴリ一覧</h1>
      <p className="mt-2 text-washi-700">
        探しているものに近いカテゴリを選んでください。
      </p>

      <ul className="mt-6 space-y-4">
        {CATEGORY_LIST.map((category) => (
          <li key={category.slug} className="card p-5">
            <h2 className="text-lg font-bold">
              <Link to={`/c/${category.slug}`} className="link">
                {category.name}
              </Link>
            </h2>
            <p className="mt-1 text-washi-700">{category.description}</p>
            <p className="mt-3 text-sm text-washi-600">
              {category.kindLabel}：
              {category.kinds.map((kind) => LISTING_KIND_LABEL[kind]).join("・")}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
