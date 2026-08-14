import { MyListingList } from "~/components/my-listing-list";
import { privatePageMeta } from "~/domain/seo";
import { requireUser } from "~/server/guards.server";
import { listOwnListings } from "~/server/services/engagement-service.server";
import type { Route } from "./+types/mypage.published";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  const listings = await listOwnListings(context.getDb(), user.id, "published");
  return { listings };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("公開中の投稿");
}

export default function Published({ loaderData }: Route.ComponentProps) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">公開中の投稿</h1>
      <p className="mt-2 text-washi-700">
        内容の修正で追加の料金がかかることはありません。
        取引が決まったら掲載を終了してください。
      </p>

      <MyListingList
        listings={loaderData.listings}
        emptyTitle="公開中の投稿はありません"
        emptyDescription="下書きから公開すると、ここに表示されます。"
        primaryAction={(listing) => ({
          label: "掲載を終了する",
          to: `/listings/${listing.id}/close`,
        })}
      />
    </div>
  );
}
