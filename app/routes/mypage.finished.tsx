import { MyListingList } from "~/components/my-listing-list";
import { privatePageMeta } from "~/domain/seo";
import { requireUser } from "~/server/guards.server";
import { listOwnListings } from "~/server/services/engagement-service.server";
import type { Route } from "./+types/mypage.finished";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  const listings = await listOwnListings(context.getDb(), user.id, "finished");
  return { listings };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("掲載終了した投稿");
}

export default function Finished({ loaderData }: Route.ComponentProps) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">掲載終了した投稿</h1>
      <p className="mt-2 text-washi-700">
        あらためて掲載する場合は、新しい投稿として作成してください。
        掲載料110円（税込）が必要です。自動で再掲載・再課金されることはありません。
      </p>

      <MyListingList
        listings={loaderData.listings}
        emptyTitle="掲載終了した投稿はありません"
        emptyDescription="掲載期間が終わった投稿や、ご自身で終了した投稿が並びます。"
      />
    </div>
  );
}
