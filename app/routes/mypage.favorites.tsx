import { ListingGrid } from "~/components/listing-grid";
import { privatePageMeta } from "~/domain/seo";
import { requireUser } from "~/server/guards.server";
import { searchListings } from "~/server/repositories/listing-repository.server";
import { listFavorites } from "~/server/services/engagement-service.server";
import type { Route } from "./+types/mypage.favorites";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  const db = context.getDb();

  const favorites = await listFavorites(db, user.id);
  if (favorites.length === 0) {
    return { listings: [], missing: 0 };
  }

  /*
   * 公開中のものだけを引き直す。掲載終了したものは一覧に出さず、件数で知らせる。
   *
   * ★ID で絞って SQL で引く。★ 以前は「新着200件を取ってから JS で
   * お気に入りと突き合わせる」だったので、サイト全体で200件を超えた瞬間、
   * 古めの掲載をお気に入りにした人には★公開中なのに「掲載が終了したため
   * 表示していません」と嘘が出た★（2026-08-17 の点検で発覚）。
   */
  const ids = favorites.map((favorite) => favorite.listingId);
  const result = await searchListings(db, {
    ids,
    sort: "newest",
    page: 1,
    perPage: Math.max(ids.length, 1),
  });

  return { listings: result.items, missing: ids.length - result.items.length };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("お気に入り");
}

export default function Favorites({ loaderData }: Route.ComponentProps) {
  const { listings, missing } = loaderData;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">お気に入り</h1>
      {missing > 0 ? (
        <p className="mt-2 text-sm text-washi-600">
          {missing}件は掲載が終了したため表示していません。
        </p>
      ) : null}
      <ListingGrid listings={listings} />
    </div>
  );
}
