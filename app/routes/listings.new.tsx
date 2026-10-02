import { Link, redirect } from "react-router";

import { ListingForm } from "~/components/listing-form";
import {
  CATEGORY_LIST,
  categoryIntakePausedMessage,
  isCategoryAcceptingNew,
  isCategorySlug,
} from "~/domain/categories";
import { privatePageMeta } from "~/domain/seo";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { readCookie } from "~/server/cookies.server";
import { toPublicError } from "~/server/errors";
import { requireUser } from "~/server/guards.server";
import { parseListingForm } from "~/server/listing-form.server";
import { enforceRateLimit } from "~/server/rate-limit.server";
import {
  listAllCities,
  listPrefectures,
} from "~/server/repositories/location-repository.server";
import { createDraft } from "~/server/services/listing-service.server";
import type { Route } from "./+types/listings.new";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  await requireUser({ request, context });

  const url = new URL(request.url);
  const categorySlug = url.searchParams.get("category");
  const db = context.getDb();

  if (!categorySlug || !isCategorySlug(categorySlug)) {
    return { step: "choose" as const, csrfToken: context.csrfToken, notice: null };
  }
  // 受付を止めたカテゴリは、フォームへ進ませず選ぶ画面に戻す（送信はサーバー側でも止める）。
  if (!isCategoryAcceptingNew(categorySlug)) {
    return {
      step: "choose" as const,
      csrfToken: context.csrfToken,
      notice: categoryIntakePausedMessage(categorySlug),
    };
  }

  const [prefectures, cities] = await Promise.all([
    listPrefectures(db),
    listAllCities(db),
  ]);

  return {
    step: "form" as const,
    categorySlug,
    csrfToken: context.csrfToken,
    prefectures: prefectures.map((row) => ({ code: row.code, name: row.name })),
    cities,
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("投稿をつくる");
}

export async function action({ request, context: rawContext }: Route.ActionArgs) {
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
    await enforceRateLimit(db, "listingCreate", user.id);

    const parsed = await parseListingForm(db, formData);
    if (!parsed.ok) return { fields: parsed.fields, message: null };

    const { listingId } = await createDraft(db, user.id, parsed.data);

    // ★下書き保存の時点では課金しない。★ 確認画面へ進む。
    return redirect(`/listings/${listingId}/confirm`);
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.error("draft creation failed", error);
    const publicError = toPublicError(error);
    return { fields: publicError.fields ?? null, message: publicError.message };
  }
}

export default function NewListing({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  if (loaderData.step === "choose") {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-bold text-washi-900">投稿をつくる</h1>
        <p className="mt-2 text-washi-700">
          カテゴリを選んでください。下書きの保存は無料です。
        </p>
        {loaderData.notice ? (
          <p role="status" className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
            {loaderData.notice}
          </p>
        ) : null}
        <ul className="mt-6 space-y-3">
          {CATEGORY_LIST.filter((category) => category.acceptsNewListings).map((category) => (
            <li key={category.slug}>
              <Link
                to={`/listings/new?category=${category.slug}`}
                className="card block p-5 hover:border-ai-300 hover:bg-ai-50"
              >
                <p className="font-semibold text-ai-900">{category.name}</p>
                <p className="mt-1 text-sm text-washi-600">
                  {category.description}
                </p>
              </Link>
            </li>
          ))}
        </ul>
        {CATEGORY_LIST.filter((category) => !category.acceptsNewListings).map((category) => (
          <p key={category.slug} className="mt-4 text-sm text-washi-600">
            {categoryIntakePausedMessage(category.slug)}
          </p>
        ))}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">投稿をつくる</h1>
      <ListingForm
        csrfToken={loaderData.csrfToken}
        categorySlug={loaderData.categorySlug}
        prefectures={loaderData.prefectures}
        cities={loaderData.cities}
        errors={actionData?.fields}
        message={actionData?.message}
        submitLabel="下書きを保存して確認へ"
      />
    </div>
  );
}
