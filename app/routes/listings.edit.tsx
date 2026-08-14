import { redirect } from "react-router";

import { ListingForm } from "~/components/listing-form";
import { isCategorySlug } from "~/domain/categories";
import { privatePageMeta } from "~/domain/seo";
import { isUlid } from "~/domain/ulid";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { notFound, toPublicError } from "~/server/errors";
import { assertOwner, requireUser } from "~/server/guards.server";
import { parseListingForm } from "~/server/listing-form.server";
import { getListingForOwner } from "~/server/repositories/listing-repository.server";
import {
  listAllCities,
  listPrefectures,
} from "~/server/repositories/location-repository.server";
import { updateListing } from "~/server/services/listing-service.server";
import type { Route } from "./+types/listings.edit";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext, params }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  if (!isUlid(params.listingId)) throw notFound("malformed id");

  const db = context.getDb();
  const listing = await getListingForOwner(db, params.listingId);
  if (!listing) throw notFound(`listing not found: ${params.listingId}`);
  // 他人の投稿は 404。存在すら知らせない。
  assertOwner(listing.ownerId, user);

  if (!isCategorySlug(listing.categorySlug)) {
    throw notFound("unknown category on listing");
  }

  const [prefectures, cities] = await Promise.all([
    listPrefectures(db),
    listAllCities(db),
  ]);

  return {
    listing,
    csrfToken: context.csrfToken,
    prefectures: prefectures.map((row) => ({ code: row.code, name: row.name })),
    cities,
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("投稿を編集する");
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

    const listing = await getListingForOwner(db, params.listingId);
    if (!listing) throw notFound(`listing not found: ${params.listingId}`);
    assertOwner(listing.ownerId, user);

    const parsed = await parseListingForm(db, formData);
    if (!parsed.ok) return { fields: parsed.fields, message: null };

    // ★公開済みの通常編集では再課金しない。★ 状態は published のまま。
    await updateListing(db, params.listingId, parsed.data);

    return redirect(
      listing.status === "published"
        ? `/listings/${params.listingId}`
        : `/listings/${params.listingId}/confirm`,
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.error("listing update failed", error);
    const publicError = toPublicError(error);
    return { fields: publicError.fields ?? null, message: publicError.message };
  }
}

export default function EditListing({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { listing } = loaderData;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">投稿を編集する</h1>
      {listing.status === "published" ? (
        <p className="mt-2 rounded-lg bg-ai-50 p-3 text-sm text-ai-900">
          公開中の投稿です。内容を修正しても、あらためて掲載料がかかることはありません。
        </p>
      ) : null}

      <ListingForm
        csrfToken={loaderData.csrfToken}
        categorySlug={listing.categorySlug}
        prefectures={loaderData.prefectures}
        cities={loaderData.cities}
        listing={listing}
        errors={actionData?.fields}
        message={actionData?.message}
        submitLabel="内容を保存する"
        lockDuration={listing.status === "published"}
      />
    </div>
  );
}
