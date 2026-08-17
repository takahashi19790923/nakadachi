import { Link } from "react-router";

import {
  categoryKindLabel,
  daysUntil,
  formatListingPrice,
} from "~/domain/listing-view";
import type { ListingSummary } from "~/domain/listing-types";

interface Props {
  listing: ListingSummary;
  /**
   * 画面の上のほうに出るカード（一覧の先頭2〜3枚）は true。
   * 全部 lazy にすると、最初に見える写真まで後回しになり、
   * 表示が整うまでの時間（LCP）が伸びる。詳細ページの1枚目と同じ扱い。
   */
  priority?: boolean;
}

export function ListingCard({ listing, priority = false }: Props) {
  const price = formatListingPrice({
    categorySlug: listing.categorySlug,
    priceType: listing.priceType,
    priceUnit: listing.priceUnit,
    priceJpy: listing.priceJpy,
    salaryMaxJpy: listing.salaryMaxJpy,
  });
  const remaining = daysUntil(listing.expiresAt);

  return (
    <article className="card h-full overflow-hidden transition-colors hover:border-ai-300">
      {/* prefetch="intent": 触れた時点で詳細のデータを先読みし、押してから DB を待たない */}
      <Link to={`/listings/${listing.id}`} className="block" prefetch="intent">
        <div className="aspect-[4/3] w-full bg-washi-100">
          {listing.imageKey ? (
            <img
              // 画像は自前の Worker 経由で配る。R2 の URL を直接出さない。
              src={`/media/${encodeURIComponent(listing.imageKey)}`}
              alt=""
              width={400}
              height={300}
              loading={priority ? "eager" : "lazy"}
              fetchPriority={priority ? "high" : "auto"}
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm text-washi-500">
              写真なし
            </div>
          )}
        </div>

        <div className="p-3">
          <p className="text-xs font-medium text-ai-700">
            {categoryKindLabel(listing.categorySlug, listing.kind)}
          </p>
          <h3 className="mt-1 line-clamp-2 font-semibold leading-snug text-washi-900">
            {listing.title}
          </h3>
          <p className="mt-2 text-lg font-bold text-kaki-700">{price}</p>
          <p className="mt-1 text-sm text-washi-600">
            {listing.prefectureName} {listing.cityName}
          </p>
          {remaining !== null && remaining >= 0 && remaining <= 3 ? (
            <p className="mt-1 text-xs font-medium text-kaki-700">
              掲載終了まであと{remaining === 0 ? "1日未満" : `${remaining}日`}
            </p>
          ) : null}
        </div>
      </Link>
    </article>
  );
}
