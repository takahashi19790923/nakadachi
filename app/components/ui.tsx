import { Link } from "react-router";

import {
  LISTING_STATUS_LABEL,
  type ListingStatus,
} from "~/domain/listing-status";

/** 投稿の状態。色だけで区別させない（必ず文字を添える） */
export function StatusBadge({ status }: { status: ListingStatus }) {
  const tone: Record<ListingStatus, string> = {
    draft: "bg-washi-200 text-washi-800",
    payment_pending: "bg-kaki-100 text-kaki-800",
    payment_processing: "bg-kaki-100 text-kaki-800",
    published: "bg-ai-100 text-ai-900",
    closed: "bg-washi-200 text-washi-700",
    rejected: "bg-red-100 text-red-800",
    suspended: "bg-red-100 text-red-800",
    expired: "bg-washi-200 text-washi-700",
    deleted: "bg-washi-200 text-washi-600",
  };

  return (
    <span
      className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${tone[status]}`}
    >
      {LISTING_STATUS_LABEL[status]}
    </span>
  );
}

/** 何も無いときの表示。「0件」だけで終わらせず、次にできることを示す */
export function EmptyState({
  title,
  description,
  actionLabel,
  actionTo,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  actionTo?: string;
}) {
  return (
    <div className="card mt-4 p-8 text-center">
      <p className="font-semibold text-washi-800">{title}</p>
      <p className="mt-2 text-sm text-washi-600">{description}</p>
      {actionLabel && actionTo ? (
        <Link to={actionTo} className="btn btn-primary mt-6">
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * ページ送り。
 * 検索エンジン向けに rel="prev"/"next" ではなく、素直なリンクを出す。
 * ★リンクであることが分かる見た目にする。★
 */
export function Pagination({
  page,
  totalPages,
  buildHref,
}: {
  page: number;
  totalPages: number;
  buildHref: (page: number) => string;
}) {
  if (totalPages <= 1) return null;

  const windowSize = 2;
  const pages: number[] = [];
  for (
    let candidate = Math.max(1, page - windowSize);
    candidate <= Math.min(totalPages, page + windowSize);
    candidate += 1
  ) {
    pages.push(candidate);
  }

  return (
    <nav aria-label="ページ送り" className="mt-8">
      <ul className="flex flex-wrap items-center justify-center gap-2">
        {page > 1 ? (
          <li>
            <Link to={buildHref(page - 1)} className="btn btn-secondary btn-sm">
              前へ
            </Link>
          </li>
        ) : null}
        {pages.map((candidate) => (
          <li key={candidate}>
            <Link
              to={buildHref(candidate)}
              aria-current={candidate === page ? "page" : undefined}
              className={
                candidate === page
                  ? "btn btn-primary btn-sm"
                  : "btn btn-secondary btn-sm"
              }
            >
              {candidate}
            </Link>
          </li>
        ))}
        {page < totalPages ? (
          <li>
            <Link to={buildHref(page + 1)} className="btn btn-secondary btn-sm">
              次へ
            </Link>
          </li>
        ) : null}
      </ul>
      <p className="mt-2 text-center text-sm text-washi-600">
        {page} / {totalPages} ページ
      </p>
    </nav>
  );
}

/** 掲載料の案内。決済に関わる画面では必ず出す */
export function FeeNotice() {
  return (
    <div className="card mt-4 border-ai-200 bg-ai-50 p-4">
      <p className="font-semibold text-ai-900">掲載料について</p>
      <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-ai-900">
        <li>掲載時に1件あたり110円（税込）をいただきます。</li>
        <li>下書きの保存では課金されません。</li>
        <li>公開後の内容の修正で、あらためて課金されることはありません。</li>
        <li>成約手数料・月額料金など、110円以外の料金は一切かかりません。</li>
        <li>自動で更新・課金されることはありません。</li>
      </ul>
    </div>
  );
}

/** 個人情報を書かないよう促す注意。投稿とメッセージの入力画面で使う */
export function PrivacyWarning() {
  return (
    <div className="card mt-4 border-kaki-200 bg-kaki-50 p-4">
      <p className="font-semibold text-kaki-800">公開される内容にご注意ください</p>
      <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-kaki-900">
        <li>
          番地・部屋番号・電話番号・メールアドレスは書かないでください。誰でも閲覧できます。
        </li>
        <li>受け渡し場所は「最寄り駅」「公共施設の近く」など、広めの範囲で書いてください。</li>
        <li>写真に表札・郵便物・車のナンバーが写っていないかご確認ください。</li>
      </ul>
    </div>
  );
}
