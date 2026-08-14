import { Form, Link, redirect } from "react-router";

import { CsrfInput } from "~/components/form";
import { privatePageMeta } from "~/domain/seo";
import { isUlid } from "~/domain/ulid";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { notFound, toPublicError } from "~/server/errors";
import { assertOwner, requireUser } from "~/server/guards.server";
import { getListingOwnership } from "~/server/repositories/listing-repository.server";
import { transitionListing } from "~/server/services/listing-service.server";
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

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("掲載を終了する");
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

    const ownership = await getListingOwnership(db, params.listingId);
    if (!ownership) throw notFound(`listing not found: ${params.listingId}`);
    assertOwner(ownership.ownerId, user);

    const intent = formString(formData, "intent", "close");
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
  const canClose = status === "published" || status === "expired";

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <h1 className="text-2xl font-bold text-washi-900">
        {canClose ? "掲載を終了しますか？" : "投稿を削除しますか？"}
      </h1>

      {actionData?.message ? (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 p-4 text-red-800">
          {actionData.message}
        </p>
      ) : null}

      <ul className="mt-4 list-inside list-disc space-y-1 text-washi-700">
        <li>掲載を終了すると、検索や一覧に表示されなくなります。</li>
        <li>
          <strong>掲載料の返金はありません。</strong>
        </li>
        <li>
          あらためて掲載する場合は、新しい投稿として作成し、
          掲載料110円（税込）が必要になります。
        </li>
        <li>やり取りの履歴はメッセージ一覧に残ります。</li>
      </ul>

      <Form method="post" className="mt-8 flex flex-wrap gap-3">
        <CsrfInput token={csrfToken} />
        <input
          type="hidden"
          name="intent"
          value={canClose ? "close" : "delete"}
        />
        <button type="submit" className="btn btn-danger">
          {canClose ? "掲載を終了する" : "投稿を削除する"}
        </button>
        <Link to={`/listings/${listingId}`} className="btn btn-secondary">
          やめる
        </Link>
      </Form>
    </div>
  );
}
