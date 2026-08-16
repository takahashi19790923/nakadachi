import { MyListingList } from "~/components/my-listing-list";
import { privatePageMeta } from "~/domain/seo";
import { requireUser } from "~/server/guards.server";
import { listOwnListings } from "~/server/services/engagement-service.server";
import type { Route } from "./+types/mypage.drafts";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  const listings = await listOwnListings(context.getDb(), user.id, "drafts");
  return { listings };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("下書き・決済待ち");
}

export default function Drafts({ loaderData }: Route.ComponentProps) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">下書き・決済待ち</h1>
      <p className="mt-2 text-washi-700">
        下書きの保存に料金はかかりません。公開するときだけ110円（税込）です。
      </p>

      <MyListingList
        listings={loaderData.listings}
        emptyTitle="下書きはありません"
        emptyDescription="投稿をつくると、まず下書きとして保存されます。"
        primaryAction={(listing) => ({
          label: "確認して公開する",
          to: `/listings/${listing.id}/confirm`,
        })}
        /*
         * ★下書きを消す手段を必ず置く。★ 無いと、作ってしまった投稿を
         * 利用者が自分で片づけられない。下書きは掲載終了と違って保持期間の
         * 対象外なので、置きっぱなしのまま永久に残る。
         *
         * 消せるかどうかの判断は確認画面に任せる。一覧が持つのは要約で
         * 状態を含まないため、ここで判断すると別の情報源が増える。
         */
        dangerAction={(listing) => ({
          label: "削除",
          to: `/listings/${listing.id}/close`,
        })}
      />
    </div>
  );
}
