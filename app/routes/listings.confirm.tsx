import { Form, Link } from "react-router";

import { CsrfInput } from "~/components/form";
import { FeeNotice, StatusBadge } from "~/components/ui";
import { CATEGORIES, LISTING_KIND_LABEL } from "~/domain/categories";
import { formatListingPrice } from "~/domain/listing-view";
import { LISTING_FEE_JPY, formatJpy } from "~/domain/pricing";
import { privatePageMeta } from "~/domain/seo";
import { isUlid } from "~/domain/ulid";
import { notFound } from "~/server/errors";
import { assertOwner, requireUser } from "~/server/guards.server";
import { getListingForOwner } from "~/server/repositories/listing-repository.server";
import type { Route } from "./+types/listings.confirm";
import { getApp } from "~/server/app-context";

/**
 * 投稿確認と決済への入口。
 *
 * ★110円がどこで発生するかを、押す前に必ず示す。★ ダークパターンを使わない。
 */
export async function loader({ request, context: rawContext, params }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  if (!isUlid(params.listingId)) throw notFound("malformed id");

  const listing = await getListingForOwner(context.getDb(), params.listingId);
  if (!listing) throw notFound(`listing not found: ${params.listingId}`);
  assertOwner(listing.ownerId, user);

  const url = new URL(request.url);
  return {
    listing,
    csrfToken: context.csrfToken,
    canceled: url.searchParams.get("canceled") === "1",
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("投稿内容の確認");
}

export default function ConfirmListing({ loaderData }: Route.ComponentProps) {
  const { listing, csrfToken, canceled } = loaderData;
  const category = CATEGORIES[listing.categorySlug];
  const price = formatListingPrice({
    categorySlug: listing.categorySlug,
    priceType: listing.priceType,
    priceUnit: listing.priceUnit,
    priceJpy: listing.priceJpy,
    salaryMaxJpy: listing.details?.salaryMaxJpy ?? null,
  });

  const alreadyPublished = listing.status === "published";

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">投稿内容の確認</h1>

      {canceled ? (
        <p className="mt-4 rounded-lg border border-washi-300 bg-washi-100 p-4 text-washi-800">
          お支払いは行われていません。投稿は下書きのまま残っています。
        </p>
      ) : null}

      <div className="card mt-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={listing.status} />
          <span className="text-sm text-washi-600">
            {category.name}・{LISTING_KIND_LABEL[listing.kind]}
          </span>
        </div>
        <h2 className="mt-3 text-lg font-bold">{listing.title}</h2>
        <p className="mt-1 text-xl font-bold text-kaki-700">{price}</p>
        <p className="mt-2 text-sm text-washi-600">
          {listing.prefectureName} {listing.cityName}
          {listing.areaNote ? `（${listing.areaNote}）` : ""}
        </p>
        <p className="mt-3 whitespace-pre-wrap break-words text-washi-800">
          {listing.body}
        </p>
        {listing.images.length > 0 ? (
          <p className="mt-3 text-sm text-washi-600">
            写真 {listing.images.length} 枚
          </p>
        ) : (
          <p className="mt-3 text-sm text-washi-600">
            写真はまだありません。
            <Link to={`/listings/${listing.id}/images`} className="link ml-1">
              写真を追加する
            </Link>
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <Link to={`/listings/${listing.id}/edit`} className="btn btn-secondary">
          内容を修正する
        </Link>
        <Link to={`/listings/${listing.id}/images`} className="btn btn-secondary">
          写真を編集する
        </Link>
      </div>

      {alreadyPublished ? (
        <p className="mt-8 rounded-lg bg-ai-50 p-4 text-ai-900">
          この投稿はすでに公開中です。
          <Link to={`/listings/${listing.id}`} className="link ml-1">
            投稿ページを見る
          </Link>
        </p>
      ) : (
        <>
          <FeeNotice />

          <Form method="post" action={`/listings/${listing.id}/checkout`} className="mt-6">
            <CsrfInput token={csrfToken} />
            <input type="hidden" name="durationDays" value="30" />

            <p className="text-lg font-bold text-washi-900">
              お支払い金額：{formatJpy(LISTING_FEE_JPY)}（税込）
            </p>
            <p className="mt-1 text-sm text-washi-600">
              次の画面（Stripe）でお支払い方法を入力します。
              お支払いが確認できた時点で投稿が公開されます。
            </p>

            <button type="submit" className="btn btn-accent mt-4 w-full">
              {formatJpy(LISTING_FEE_JPY)}を支払って公開する
            </button>
          </Form>

          <p className="mt-4 text-sm text-washi-600">
            公開せずにやめる場合は、このまま画面を離れてください。下書きは
            <Link to="/mypage/drafts" className="link mx-1">
              下書き一覧
            </Link>
            に残ります。
          </p>
        </>
      )}
    </div>
  );
}
