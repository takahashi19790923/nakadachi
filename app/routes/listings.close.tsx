import { Form, Link, redirect } from "react-router";

import { CsrfInput } from "~/components/form";
import {
  blockedCloseMessage,
  CLOSE_PAGE_HEADING,
  CLOSE_PAGE_INTENT,
  CLOSE_PAGE_TITLE,
  closePageMode,
} from "~/domain/listing-status";
import { privatePageMeta } from "~/domain/seo";
import { isUlid } from "~/domain/ulid";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { AppError, notFound, toPublicError } from "~/server/errors";
import { assertOwner, requireUser } from "~/server/guards.server";
import { enforceRateLimit } from "~/server/rate-limit.server";
import { getListingOwnership } from "~/server/repositories/listing-repository.server";
import { transitionListing } from "~/server/services/listing-service.server";
import { cancelOpenCheckouts } from "~/server/services/payment/payment-service.server";
import { formString } from "~/domain/validation/common";
import type { Route } from "./+types/listings.close";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext, params }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  if (!isUlid(params.listingId)) throw notFound("malformed id");

  const ownership = await getListingOwnership(context.getDb(), params.listingId);
  if (!ownership) throw notFound(`listing not found: ${params.listingId}`);
  assertOwner(ownership.ownerId, user);

  return {
    listingId: params.listingId,
    status: ownership.status,
    csrfToken: context.csrfToken,
  };
}

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  // ★見出しと同じところから作る。★ 別々に書くと片方だけ古くなる。
  const mode = loaderData ? closePageMode(loaderData.status) : "close";
  return privatePageMeta(CLOSE_PAGE_TITLE[mode]);
}

export async function action({ request, context: rawContext, params }: Route.ActionArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  const db = context.getDb();
  const formData = await request.formData();

  try {
    assertSameOrigin(request, context.env);
    await verifyCsrfToken(
      context.env,
      formData.get("_csrf"),
      readCookie(request, csrfCookieName(context.env)),
    );
    // 書き込みの回数（監査 SEC-04。rate-limit.server.ts の説明）。
    await enforceRateLimit(context.getDb(), "listingClose", user.id);

    const ownership = await getListingOwnership(db, params.listingId);
    if (!ownership) throw notFound(`listing not found: ${params.listingId}`);
    assertOwner(ownership.ownerId, user);

    const intent = formString(formData, "intent", "close");

    /*
     * ★決済待ちの投稿を消すときは、生きた支払いリンクを先に無効にする。★（監査 FN-07）
     * 以前は状態だけ変えていたので、消した投稿の支払いリンクが期限まで払えた。
     * 払い終わった直後（確認中）なら消させない。消すと «払ったのに投稿が無い» になる。
     */
    if (
      intent === "delete" &&
      (ownership.status === "payment_pending" || ownership.status === "payment_processing")
    ) {
      const { paidInProgress } = await cancelOpenCheckouts({
        db,
        env: context.env,
        logger: context.logger,
        listingId: params.listingId,
      });
      if (paidInProgress) {
        throw new AppError(
          "conflict",
          "お支払いの確認中のため、いまは削除できません。数分たってからもう一度お試しください。しばらくたっても変わらない場合は、お問い合わせください。",
          { detail: `delete blocked: checkout complete or unknown for ${params.listingId}` },
        );
      }
    }

    // 遷移の可否は assertTransition が判断する。ここで status を直接書かない。
    await transitionListing(db, {
      listingId: params.listingId,
      to: intent === "delete" ? "deleted" : "closed",
      actor: "owner",
    });

    return redirect(intent === "delete" ? "/mypage/drafts" : "/mypage/finished");
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.error("close listing failed", error);
    return { message: toPublicError(error).message };
  }
}

export default function CloseListing({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { listingId, status, csrfToken } = loaderData;
  const mode = closePageMode(status);
  const canClose = mode === "close";

  if (mode === "blocked") {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-10">
        <h1 className="text-2xl font-bold text-washi-900">
          {CLOSE_PAGE_HEADING.blocked}
        </h1>
        <p className="mt-4 text-washi-700">{blockedCloseMessage(status)}</p>
        <Link to="/mypage" className="btn btn-secondary mt-6">
          マイページへ戻る
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <h1 className="text-2xl font-bold text-washi-900">
        {CLOSE_PAGE_HEADING[mode]}
      </h1>

      {actionData?.message ? (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 p-4 text-red-800">
          {actionData.message}
        </p>
      ) : null}

      {/*
        ★公開中と下書きで説明を変える。★ 下書きはまだ1円も払っていないので、
        「掲載料の返金はありません」と出すと、払った覚えのない人を不安に
        させるうえ、事実とも違う。
      */}
      {canClose ? (
        <ul className="mt-4 list-inside list-disc space-y-1 text-washi-700">
          <li>掲載を終了すると、検索や一覧に表示されなくなります。</li>
          <li>
            <strong>ご自身で掲載を終了した場合、掲載料の返金はありません。</strong>
          </li>
          <li>
            あらためて掲載する場合は、新しい投稿として作成し、
            掲載料110円（税込）が必要になります。
          </li>
          <li>やり取りの履歴はメッセージ一覧に残ります。</li>
        </ul>
      ) : (
        <ul className="mt-4 list-inside list-disc space-y-1 text-washi-700">
          <li>この投稿はまだ公開されていません。</li>
          {status === "payment_pending" ? (
            <li>
              お支払いがお済みの場合は、削除した後でも掲載料の全額を返金します。
              お問い合わせからご連絡ください。
            </li>
          ) : (
            <li>
              <strong>料金は発生していません。</strong>削除しても費用は
              かかりません。
            </li>
          )}
          <li>削除すると元に戻せません。写真も一緒に削除されます。</li>
        </ul>
      )}

      <Form method="post" className="mt-8 flex flex-wrap gap-3">
        <CsrfInput token={csrfToken} />
        <input type="hidden" name="intent" value={CLOSE_PAGE_INTENT[mode]} />
        <button type="submit" className="btn btn-danger">
          {CLOSE_PAGE_TITLE[mode]}
        </button>
        {/*
          ★戻り先を状態で変える。★ 下書きの投稿ページ（/listings/:id）は
          公開中しか出さないので 404 になる。「やめる」で行き止まりにしない。
        */}
        <Link
          to={canClose ? `/listings/${listingId}` : "/mypage/drafts"}
          className="btn btn-secondary"
        >
          やめる
        </Link>
      </Form>
    </div>
  );
}
