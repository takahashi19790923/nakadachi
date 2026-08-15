import { useEffect } from "react";
import { Link, useFetcher } from "react-router";

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

/** /listings/:id/checkout の action が返すもの */
interface CheckoutActionData {
  readonly redirectUrl?: string;
  readonly message?: string | null;
}

export default function ConfirmListing({ loaderData }: Route.ComponentProps) {
  const { listing, csrfToken, canceled } = loaderData;
  const fetcher = useFetcher<CheckoutActionData>();

  /*
   * ★決済画面へは、ここから window.location.assign で移動する。★
   *
   * 遠回りに見えるが、他の書き方が全部だめだった。実機で順に踏んだ。
   *
   *  1. action で redirect(stripeのURL) を返す
   *     → <Form> の fetch が 302 を透過的に追ってしまい、クライアントには
   *       何も伝わらない。★ボタンを押しても無反応。★例外もログも出ない。
   *  2. <Form reloadDocument> で素のフォーム送信にする
   *     → 文書遷移の POST は origin ヘッダが null になることがあり、
   *       React Router が forwarded action request と見なして中断する。
   *       画面には素の Bad Request だけが出る。
   *  3. 通常の <Form> で action からURLを返し、/checkout の画面で移動する
   *     → action の後の再検証で /checkout の loader が走る。あの loader は
   *       GET を confirm へ戻すために redirect を投げるので、
   *       ★移動する画面が描画される前に confirm へ戻される。★
   *
   * fetcher なら画面遷移が起きないので、loader の再検証も起きない。
   * 受け取った URL でそのまま移動する。
   */
  const redirectUrl = fetcher.data?.redirectUrl;
  useEffect(() => {
    if (redirectUrl) window.location.assign(redirectUrl);
  }, [redirectUrl]);

  // 送信中と、移動待ちのあいだはボタンを止める。連打で Session が増える。
  const submitting = fetcher.state !== "idle" || Boolean(redirectUrl);
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

      {/*
        ★「下書きのまま」と書かない。★ 決済をやめて戻ってきた時点では、
        投稿の状態は payment_pending で、すぐ下のバッジには「決済待ち」と出る。
        文言とバッジが食い違うと、料金がどうなったのか読み手が判断できない。
        伝えるべきは状態の名前ではなく「請求されていない」ことのほう。
      */}
      {canceled ? (
        <p className="mt-4 rounded-lg border border-washi-300 bg-washi-100 p-4 text-washi-800">
          お支払いは行われていません。料金は請求されていません。
          このままもう一度お支払いに進むこともできますし、あとから
          <Link to="/mypage/drafts" className="link mx-1">
            下書き一覧
          </Link>
          でやり直すこともできます。
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

          <fetcher.Form
            method="post"
            action={`/listings/${listing.id}/checkout`}
            className="mt-6"
          >
            <CsrfInput token={csrfToken} />
            <input type="hidden" name="durationDays" value="30" />

            <p className="text-lg font-bold text-washi-900">
              お支払い金額：{formatJpy(LISTING_FEE_JPY)}（税込）
            </p>
            <p className="mt-1 text-sm text-washi-600">
              次の画面（Stripe）でお支払い方法を入力します。
              お支払いが確認できた時点で投稿が公開されます。
            </p>

            {fetcher.data?.message ? (
              <p className="mt-4 rounded-lg border border-kaki-300 bg-kaki-50 p-3 text-kaki-900">
                {fetcher.data.message}
              </p>
            ) : null}

            <button
              type="submit"
              className="btn btn-accent mt-4 w-full"
              disabled={submitting}
            >
              {redirectUrl
                ? "お支払い画面へ移動しています…"
                : fetcher.state !== "idle"
                  ? "準備しています…"
                  : `${formatJpy(LISTING_FEE_JPY)}を支払って公開する`}
            </button>
          </fetcher.Form>

          {/*
            ★JavaScript で移動できなかったときの逃げ道。★
            ここが無いと、移動に失敗した人は「押したのに何も起きない」まま
            取り残される。決済は取りこぼしが直接お金になるので、必ず残す。
          */}
          {redirectUrl ? (
            <p className="mt-3 text-sm text-washi-700">
              切り替わらない場合は
              <a href={redirectUrl} className="link mx-1">
                こちらからお支払いへ進んでください
              </a>
              。
            </p>
          ) : null}

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
