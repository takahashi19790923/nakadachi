import { Link } from "react-router";

import type { ListingSummary } from "~/domain/listing-types";
import {
  categoryKindLabel,
  formatDateJa,
  formatListingPrice,
} from "~/domain/listing-view";
import { EmptyState } from "./ui";

/**
 * マイページの投稿一覧。
 * 下書き・公開中・掲載終了で同じ見せ方をする（状態ごとに別の画面を作らない）。
 */
export function MyListingList({
  listings,
  emptyTitle,
  emptyDescription,
  primaryAction,
  dangerAction,
}: {
  listings: ListingSummary[];
  emptyTitle: string;
  emptyDescription: string;
  primaryAction?: (listing: ListingSummary) => { label: string; to: string };
  /**
   * 削除など、取り消せない操作。null を返せばその行には出さない。
   *
   * ★出す条件を呼ぶ側に決めさせる。★ 状態によっては遷移が許されず、
   * 押した瞬間にエラーになる（決済の確認中など）。押せるのに失敗する
   * ボタンは、利用者から見ると「壊れている」と区別がつかない。
   */
  dangerAction?: (
    listing: ListingSummary,
  ) => { label: string; to: string } | null;
}) {
  if (listings.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        actionLabel="投稿をつくる"
        actionTo="/listings/new"
      />
    );
  }

  return (
    <ul className="mt-4 space-y-3">
      {listings.map((listing) => {
        const action = primaryAction?.(listing);
        const danger = dangerAction?.(listing) ?? null;
        return (
          <li key={listing.id} className="card p-4">
            <div className="flex flex-wrap items-start gap-4">
              {listing.imageKey ? (
                <img
                  src={`/media/${encodeURIComponent(listing.imageKey)}`}
                  alt=""
                  width={96}
                  height={96}
                  loading="lazy"
                  className="h-24 w-24 shrink-0 rounded-lg object-cover"
                />
              ) : (
                <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-lg bg-washi-100 text-xs text-washi-500">
                  写真なし
                </div>
              )}

              <div className="min-w-0 flex-1">
                <p className="text-xs text-ai-700">
                  {categoryKindLabel(listing.categorySlug, listing.kind)}
                </p>
                <h3 className="mt-1 font-semibold text-washi-900">
                  {listing.title}
                </h3>
                <p className="mt-1 text-kaki-700">
                  {formatListingPrice({
                    categorySlug: listing.categorySlug,
                    priceType: listing.priceType,
                    priceUnit: listing.priceUnit,
                    priceJpy: listing.priceJpy,
                    salaryMaxJpy: listing.salaryMaxJpy,
                  })}
                </p>
                <p className="mt-1 text-sm text-washi-600">
                  {listing.prefectureName} {listing.cityName}
                  {listing.expiresAt
                    ? `／掲載終了予定 ${formatDateJa(listing.expiresAt)}`
                    : ""}
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {action ? (
                <Link to={action.to} className="btn btn-primary btn-sm">
                  {action.label}
                </Link>
              ) : null}
              <Link
                to={`/listings/${listing.id}/edit`}
                className="btn btn-secondary btn-sm"
              >
                編集
              </Link>
              <Link
                to={`/listings/${listing.id}/images`}
                className="btn btn-secondary btn-sm"
              >
                写真
              </Link>
              {danger ? (
                // 確認画面を挟む。一覧から1押しで消えないようにする。
                <Link to={danger.to} className="btn btn-secondary btn-sm ml-auto text-red-700">
                  {danger.label}
                </Link>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
