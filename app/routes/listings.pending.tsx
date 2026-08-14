import { Link, redirect } from "react-router";

import { privatePageMeta } from "~/domain/seo";
import { isUlid } from "~/domain/ulid";
import { notFound } from "~/server/errors";
import { assertOwner, requireUser } from "~/server/guards.server";
import { getListingOwnership } from "~/server/repositories/listing-repository.server";
import { getPaymentStateForListing } from "~/server/services/payment/payment-service.server";
import type { Route } from "./+types/listings.pending";
import { getApp } from "~/server/app-context";

/**
 * 決済完了待ち。Stripe の success URL からの戻り先。
 *
 * ★★この画面に来ただけでは公開しない。★★
 * ここでやるのは「今どうなっているか」を読むことだけで、状態は一切変えない。
 * 公開できるのは署名検証済みの Webhook を受けた経路だけ。
 *
 * Webhook は数秒で届くが、遅れることもある。JavaScript が無い環境でも
 * 進捗が分かるよう、meta refresh で5秒ごとに読み直す。
 */
export async function loader({ request, context: rawContext, params }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  if (!isUlid(params.listingId)) throw notFound("malformed id");

  const db = context.getDb();
  const ownership = await getListingOwnership(db, params.listingId);
  if (!ownership) throw notFound(`listing not found: ${params.listingId}`);
  assertOwner(ownership.ownerId, user);

  // 公開まで進んでいれば投稿ページへ送る。
  if (ownership.status === "published") {
    throw redirect(`/listings/${params.listingId}?published=1`);
  }

  const payment = await getPaymentStateForListing(db, params.listingId);

  return {
    listingId: params.listingId,
    listingStatus: ownership.status,
    paymentStatus: payment?.status ?? null,
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("お支払いの確認中");
}

export default function PendingPayment({ loaderData }: Route.ComponentProps) {
  const { listingId, listingStatus, paymentStatus } = loaderData;

  const failed = paymentStatus === "failed" || paymentStatus === "expired";

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      {/* JavaScript が無くても進捗が更新されるようにする */}
      {!failed ? <meta httpEquiv="refresh" content="5" /> : null}

      <h1 className="text-2xl font-bold text-washi-900">
        {failed ? "お支払いを確認できませんでした" : "お支払いを確認しています"}
      </h1>

      {failed ? (
        <>
          <p className="mt-4 text-washi-700">
            投稿は下書きとして残っています。料金は請求されていません。
          </p>
          <Link
            to={`/listings/${listingId}/confirm`}
            className="btn btn-primary mt-6"
          >
            もう一度手続きする
          </Link>
        </>
      ) : (
        <>
          <p className="mt-4 text-washi-700">
            決済事業者からの確認をお待ちしています。通常は数秒で完了します。
            この画面は自動的に更新されます。
          </p>
          <p className="mt-2 text-sm text-washi-600">
            現在の状態：
            {listingStatus === "payment_processing"
              ? "確認中（コンビニ払い等の場合、入金後に公開されます）"
              : "決済待ち"}
          </p>
          <p className="mt-6 text-sm text-washi-600">
            数分たっても変わらない場合は、
            <Link to="/mypage/drafts" className="link mx-1">
              下書き一覧
            </Link>
            からご確認ください。二重に請求されることはありません。
          </p>
        </>
      )}
    </div>
  );
}
