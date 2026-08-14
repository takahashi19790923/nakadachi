import { Form, Link } from "react-router";

import { SITE } from "~/config/site";
import { StatusBadge } from "~/components/ui";
import { CsrfInput } from "~/components/form";
import {
  CATEGORIES,
  HANDOVER_METHOD_LABEL,
  ITEM_CONDITION_LABEL,
  LISTING_KIND_LABEL,
  type HandoverMethod,
  type ItemCondition,
} from "~/domain/categories";
import {
  formatDateJa,
  formatListingPrice,
} from "~/domain/listing-view";
import { buildPageMeta, toMetaDescription } from "~/domain/seo";
import { isUlid } from "~/domain/ulid";
import { notFound } from "~/server/errors";
import { loadUser } from "~/server/guards.server";
import {
  getPublishedListing,
  incrementViewCount,
} from "~/server/repositories/listing-repository.server";
import { getPublicProfile } from "~/server/repositories/user-repository.server";
import { isFavorited } from "~/server/services/engagement-service.server";
import type { Route } from "./+types/listing-detail";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext, params }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  // ★受け取った値をエラーメッセージに載せない。★ 利用者の入力をそのまま
  // 反射させない、という原則をここでも守る。
  if (!isUlid(params.listingId)) {
    throw notFound("malformed listing id");
  }

  const db = context.getDb();
  const listing = await getPublishedListing(db, params.listingId);

  // 公開中でなければ、下書き・決済待ち・削除済みのいずれであっても 404。
  // 「非公開です」と返すと、その ID の投稿が存在することが分かる。
  if (!listing) throw notFound(`listing not visible: ${params.listingId}`);

  const viewer = await loadUser({ request, context });
  const [owner, favorited] = await Promise.all([
    getPublicProfile(db, listing.ownerId),
    viewer ? isFavorited(db, viewer.id, listing.id) : Promise.resolve(false),
  ]);

  // 閲覧数の更新で応答を待たせない。失敗しても画面は壊さない。
  context.ctx.waitUntil(
    incrementViewCount(db, listing.id).catch(() => undefined),
  );

  return {
    listing,
    ownerName: owner?.displayName ?? "退会したユーザー",
    ownerJoinedAt: owner?.joinedAt?.toISOString() ?? null,
    favorited,
    isOwner: viewer?.id === listing.ownerId,
    isLoggedIn: viewer !== null,
    csrfToken: context.csrfToken,
    origin: context.env.APP_ORIGIN,
  };
}

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  if (!loaderData) return [{ title: SITE.name }];
  const { listing } = loaderData;
  return buildPageMeta({
    title: `${listing.title} | ${listing.prefectureName}${listing.cityName} | ${SITE.name}`,
    // ★本文から連絡先らしき文字列を落としてから使う。★
    description: toMetaDescription(listing.body),
    path: `/listings/${listing.id}`,
    origin: loaderData.origin,
    ogType: "article",
    ogImagePath: listing.imageKey
      ? `/media/${encodeURIComponent(listing.imageKey)}`
      : undefined,
  });
}

/**
 * 構造化データ。
 * ★氏名・連絡先を入れない。★ 検索結果に個人情報が出る経路を作らない。
 * `</script>` で閉じられないよう `<` をエスケープする。
 */
function structuredData(data: Route.ComponentProps["loaderData"]): string {
  const { listing, origin } = data;
  const payload = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: listing.title,
    description: toMetaDescription(listing.body, 300),
    url: new URL(`/listings/${listing.id}`, origin).toString(),
    ...(listing.imageKey
      ? {
          image: new URL(
            `/media/${encodeURIComponent(listing.imageKey)}`,
            origin,
          ).toString(),
        }
      : {}),
    ...(listing.priceJpy !== null && listing.priceType !== "negotiable"
      ? {
          offers: {
            "@type": "Offer",
            price: listing.priceJpy,
            priceCurrency: "JPY",
            availability: "https://schema.org/InStock",
            areaServed: `${listing.prefectureName}${listing.cityName}`,
          },
        }
      : {}),
  };
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

export default function ListingDetail({ loaderData }: Route.ComponentProps) {
  const { listing, ownerName, favorited, isOwner, isLoggedIn, csrfToken } =
    loaderData;
  const category = CATEGORIES[listing.categorySlug];
  const price = formatListingPrice({
    categorySlug: listing.categorySlug,
    priceType: listing.priceType,
    priceUnit: listing.priceUnit,
    priceJpy: listing.priceJpy,
    salaryMaxJpy: listing.details?.salaryMaxJpy ?? null,
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <script
        type="application/ld+json"
        // 構造化データはブラウザが実行しないデータブロック。
        dangerouslySetInnerHTML={{ __html: structuredData(loaderData) }}
      />

      <nav aria-label="パンくず" className="text-sm text-washi-600">
        <Link to={`/c/${category.slug}`} className="link">
          {category.name}
        </Link>
        <span aria-hidden="true"> ／ </span>
        <Link to={`/area/${listing.prefectureCode}`} className="link">
          {listing.prefectureName}
        </Link>
      </nav>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <StatusBadge status={listing.status} />
        <span className="rounded-full bg-ai-50 px-3 py-1 text-xs font-semibold text-ai-800">
          {LISTING_KIND_LABEL[listing.kind]}
        </span>
      </div>

      <h1 className="mt-3 text-2xl font-bold leading-snug text-washi-900">
        {listing.title}
      </h1>
      <p className="mt-2 text-2xl font-bold text-kaki-700">{price}</p>

      {listing.images.length > 0 ? (
        <ul className="mt-6 space-y-3">
          {listing.images.map((image, index) => (
            <li key={image.objectKey}>
              <img
                src={`/media/${encodeURIComponent(image.objectKey)}`}
                alt={`${listing.title} の写真 ${index + 1}`}
                width={image.width}
                height={image.height}
                loading={index === 0 ? "eager" : "lazy"}
                decoding="async"
                className="w-full rounded-xl border border-washi-200 bg-white object-contain"
              />
            </li>
          ))}
        </ul>
      ) : null}

      <section className="mt-6" aria-labelledby="body-heading">
        <h2 id="body-heading" className="text-lg font-bold">
          説明
        </h2>
        {/* 改行だけを反映する。HTML としては描かない（XSS 対策） */}
        <p className="mt-2 whitespace-pre-wrap break-words text-washi-800">
          {listing.body}
        </p>
      </section>

      <section className="mt-6" aria-labelledby="detail-heading">
        <h2 id="detail-heading" className="text-lg font-bold">
          詳細
        </h2>
        <dl className="card mt-2 divide-y divide-washi-200">
          <Row label="地域">
            {listing.prefectureName} {listing.cityName}
            {listing.areaNote ? `（${listing.areaNote}）` : ""}
          </Row>
          {listing.details?.itemCondition ? (
            <Row label="商品の状態">
              {ITEM_CONDITION_LABEL[listing.details.itemCondition as ItemCondition]}
            </Row>
          ) : null}
          {listing.details?.handoverMethod ? (
            <Row label="受け渡し方法">
              {
                HANDOVER_METHOD_LABEL[
                  listing.details.handoverMethod as HandoverMethod
                ]
              }
            </Row>
          ) : null}
          {listing.details?.depositRequired !== null &&
          listing.details?.depositRequired !== undefined ? (
            <Row label="デポジット">
              {listing.details.depositRequired ? "あり" : "なし"}
              {listing.details.depositNote ? (
                <span className="mt-1 block text-sm text-washi-600">
                  {listing.details.depositNote}
                  <br />
                  ※当サービスは預かり金を扱いません。当事者間で取り決めてください。
                </span>
              ) : null}
            </Row>
          ) : null}
          {listing.details?.availableFrom || listing.details?.availableTo ? (
            <Row label="貸出可能期間">
              {listing.details.availableFrom ?? "指定なし"} 〜{" "}
              {listing.details.availableTo ?? "指定なし"}
            </Row>
          ) : null}
          {listing.details?.rentalTerms ? (
            <Row label="貸出条件">{listing.details.rentalTerms}</Row>
          ) : null}
          {listing.details?.serviceContent ? (
            <Row label="提供内容">{listing.details.serviceContent}</Row>
          ) : null}
          {listing.details?.availabilityNote ? (
            <Row label="対応可能日時">{listing.details.availabilityNote}</Row>
          ) : null}
          {listing.details?.companyName ? (
            <Row label="会社名・事業者名">{listing.details.companyName}</Row>
          ) : null}
          {listing.details?.workLocationNote ? (
            <Row label="勤務地">{listing.details.workLocationNote}</Row>
          ) : null}
          {listing.details?.workHours ? (
            <Row label="勤務時間">{listing.details.workHours}</Row>
          ) : null}
          {listing.details?.qualifications ? (
            <Row label="応募資格">{listing.details.qualifications}</Row>
          ) : null}
          {listing.details?.benefits ? (
            <Row label="福利厚生">{listing.details.benefits}</Row>
          ) : null}
          <Row label="掲載終了予定">
            {listing.expiresAt ? formatDateJa(listing.expiresAt) : "未定"}
          </Row>
          <Row label="投稿者">{ownerName}</Row>
        </dl>
      </section>

      <section className="mt-6 flex flex-wrap gap-3">
        {isOwner ? (
          <>
            <Link to={`/listings/${listing.id}/edit`} className="btn btn-primary">
              この投稿を編集する
            </Link>
            <Link
              to={`/listings/${listing.id}/close`}
              className="btn btn-secondary"
            >
              掲載を終了する
            </Link>
          </>
        ) : (
          <>
            <Link
              to={`/listings/${listing.id}/contact`}
              className="btn btn-primary"
            >
              投稿者に問い合わせる
            </Link>
            <Form method="post" action={`/listings/${listing.id}/favorite`}>
              <CsrfInput token={csrfToken} />
              <input
                type="hidden"
                name="intent"
                value={favorited ? "remove" : "add"}
              />
              <button type="submit" className="btn btn-secondary">
                {favorited ? "お気に入りから外す" : "お気に入りに追加"}
              </button>
            </Form>
          </>
        )}
      </section>

      <section className="mt-8 rounded-lg border border-washi-200 bg-white p-4 text-sm text-washi-700">
        <h2 className="font-semibold text-washi-900">取引の前にお読みください</h2>
        <ul className="mt-2 list-inside list-disc space-y-1">
          <li>
            当サービスは取引の当事者ではありません。金銭のやり取り・品物の状態・
            契約内容については、当事者どうしでご確認ください。
          </li>
          <li>
            前払いや電子マネーでの送金を求められた場合はご注意ください。
            <Link to="/guide/safety" className="link ml-1">
              安全な取引のためのガイド
            </Link>
          </li>
          <li>
            <Link to={`/listings/${listing.id}/report`} className="link">
              この投稿を通報する
            </Link>
            {isLoggedIn ? null : "（ログインが必要です）"}
          </li>
        </ul>
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 p-4 sm:grid-cols-[10rem_1fr]">
      <dt className="text-sm font-semibold text-washi-600">{label}</dt>
      <dd className="text-washi-900">{children}</dd>
    </div>
  );
}
