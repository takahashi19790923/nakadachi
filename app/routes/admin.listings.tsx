import { Link } from "react-router";

import { StatusBadge } from "~/components/ui";
import { formatDateTimeJa } from "~/domain/listing-view";
import { ENDED_LISTING_STATUSES, SUSPENDED_REVIEW_DAYS } from "~/domain/retention";
import {
  LISTING_STATUSES,
  LISTING_STATUS_LABEL,
  isListingStatus,
} from "~/domain/listing-status";
import { privatePageMeta } from "~/domain/seo";
import { requireAdminGate } from "~/server/guards.server";
import { listListingsForAdmin } from "~/server/repositories/admin-repository.server";
import type { Route } from "./+types/admin.listings";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  await requireAdminGate({ request, context });

  const statusParam = new URL(request.url).searchParams.get("status");
  const status = isListingStatus(statusParam) ? statusParam : undefined;

  const rows = await listListingsForAdmin(context.getDb(), { status });

  return {
    status: status ?? "",
    listings: rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      ownerName: row.ownerName ?? "（退会）",
      createdAt: row.createdAt.toISOString(),
      // 掲載が見えなくなってからの日数。DB が数えたものをそのまま使う
      endedDaysAgo: row.endedDaysAgo,
      moderationReason: row.moderationReason,
    })),
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("投稿一覧（管理）");
}

export default function AdminListings({ loaderData }: Route.ComponentProps) {
  const { listings, status } = loaderData;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">投稿一覧（管理）</h1>

      <nav aria-label="状態でしぼる" className="mt-4">
        <ul className="flex flex-wrap gap-2 text-sm">
          <li>
            <Link
              to="/admin/listings"
              className={status === "" ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm"}
            >
              すべて
            </Link>
          </li>
          {LISTING_STATUSES.filter((value) => value !== "deleted").map((value) => (
            <li key={value}>
              <Link
                to={`/admin/listings?status=${value}`}
                className={
                  status === value
                    ? "btn btn-primary btn-sm"
                    : "btn btn-secondary btn-sm"
                }
              >
                {LISTING_STATUS_LABEL[value]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <ul className="mt-6 space-y-2">
        {listings.map((listing) => (
          <li key={listing.id} className="card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={listing.status} />
              <span className="text-sm text-washi-600">
                {listing.ownerName}・{formatDateTimeJa(listing.createdAt)}
              </span>
              {/*
                ★終わった掲載には «終わってから何日» を出す。★
                停止は自動では消えないので、放置に気づく手がかりがここにしか無い。
              */}
              {(ENDED_LISTING_STATUSES as readonly string[]).includes(
                listing.status,
              ) || listing.status === "suspended" ? (
                <span
                  className={
                    listing.status === "suspended" &&
                    listing.endedDaysAgo >= SUSPENDED_REVIEW_DAYS
                      ? "rounded bg-red-100 px-2 py-0.5 text-sm font-bold text-red-900"
                      : "text-sm text-washi-600"
                  }
                >
                  {listing.status === "suspended" ? "停止から" : "終了から"}
                  {listing.endedDaysAgo}日
                </span>
              ) : null}
            </div>
            <p className="mt-2 font-semibold text-washi-900">{listing.title}</p>
            {listing.moderationReason ? (
              <p className="mt-1 text-sm text-red-700">
                対応理由：{listing.moderationReason}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                to={`/admin/listings/${listing.id}`}
                className="btn btn-primary btn-sm"
              >
                対応する
              </Link>
              <Link
                to={`/listings/${listing.id}`}
                className="btn btn-secondary btn-sm"
              >
                公開ページ
              </Link>
            </div>
          </li>
        ))}
      </ul>

      {listings.length === 0 ? (
        <p className="mt-6 text-washi-600">該当する投稿はありません。</p>
      ) : null}
    </div>
  );
}
