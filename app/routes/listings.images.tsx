import { Form, Link } from "react-router";

import { CsrfInput, ErrorSummary } from "~/components/form";
import { PrivacyWarning } from "~/components/ui";
import { privatePageMeta } from "~/domain/seo";
import { isUlid } from "~/domain/ulid";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { notFound, toPublicError } from "~/server/errors";
import { assertOwner, requireUser } from "~/server/guards.server";
import { enforceRateLimit } from "~/server/rate-limit.server";
import { getListingForOwner } from "~/server/repositories/listing-repository.server";
import {
  MAX_IMAGES_PER_LISTING,
  MAX_IMAGE_MEGABYTES,
} from "~/domain/image-limits";
import {
  removeListingImage,
  uploadListingImage,
} from "~/server/services/media/media-service.server";
import { formString } from "~/domain/validation/common";
import type { Route } from "./+types/listings.images";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext, params }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  if (!isUlid(params.listingId)) throw notFound("malformed id");

  const listing = await getListingForOwner(context.getDb(), params.listingId);
  if (!listing) throw notFound(`listing not found: ${params.listingId}`);
  assertOwner(listing.ownerId, user);

  return {
    listingId: listing.id,
    title: listing.title,
    images: listing.images,
    csrfToken: context.csrfToken,
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("写真の編集");
}

export async function action({ request, context: rawContext, params }: Route.ActionArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  const db = context.getDb();

  try {
    assertSameOrigin(request, context.env);
    const formData = await request.formData();
    await verifyCsrfToken(
      context.env,
      formData.get("_csrf"),
      readCookie(request, csrfCookieName(context.env)),
    );

    // ★所有者の確認をアップロードの前に行う。★ 先に受け取ってしまうと、
    // 他人の投稿へ大量に送りつけるだけで帯域を消費させられる。
    const listing = await getListingForOwner(db, params.listingId);
    if (!listing) throw notFound(`listing not found: ${params.listingId}`);
    assertOwner(listing.ownerId, user);

    const intent = formString(formData, "intent", "upload");

    if (intent === "remove") {
      const imageId = formString(formData, "imageId");
      if (!isUlid(imageId)) throw notFound("malformed image id");
      await removeListingImage({ db, imageId, listingId: listing.id });
      return { message: null, fields: null, uploaded: 0 };
    }

    await enforceRateLimit(db, "imageUpload", user.id);

    const files = formData
      .getAll("images")
      .filter((value): value is File => value instanceof File && value.size > 0);

    if (files.length === 0) {
      return {
        message: "画像を選択してください。",
        fields: null,
        uploaded: 0,
      };
    }

    let uploaded = 0;
    for (const file of files) {
      await uploadListingImage({
        db,
        env: context.env,
        logger: context.logger,
        listingId: listing.id,
        file,
      });
      uploaded += 1;
    }

    return { message: null, fields: null, uploaded };
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.error("image action failed", error);
    const publicError = toPublicError(error);
    return {
      message: publicError.message,
      fields: publicError.fields ?? null,
      uploaded: 0,
    };
  }
}

export default function ListingImages({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { listingId, title, images, csrfToken } = loaderData;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">写真の編集</h1>
      <p className="mt-1 text-washi-600">{title}</p>

      <ErrorSummary message={actionData?.message} fields={actionData?.fields} />
      {actionData?.uploaded ? (
        <p role="status" className="mt-4 rounded-lg bg-ai-50 p-3 text-ai-900">
          {actionData.uploaded}枚をアップロードしました。
        </p>
      ) : null}

      <PrivacyWarning />

      <Form
        method="post"
        encType="multipart/form-data"
        className="card mt-6 p-5"
      >
        <CsrfInput token={csrfToken} />
        <input type="hidden" name="intent" value="upload" />

        <label className="field-label" htmlFor="images">
          写真を追加
        </label>
        <input
          id="images"
          name="images"
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          className="field-input"
        />
        <p className="field-hint">
          JPEG・PNG・WebP のみ。1枚
          {MAX_IMAGE_MEGABYTES}MBまで、1件につき
          {MAX_IMAGES_PER_LISTING}枚まで。
          位置情報などの付帯情報は保存時に取り除きます。
        </p>

        <button type="submit" className="btn btn-primary mt-4">
          アップロードする
        </button>
      </Form>

      <h2 className="mt-8 text-lg font-bold">現在の写真（{images.length}枚）</h2>
      {images.length === 0 ? (
        <p className="mt-2 text-washi-600">まだ写真がありません。</p>
      ) : (
        <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.map((image, index) => (
            <li key={image.objectKey} className="card overflow-hidden">
              <img
                src={`/media/${encodeURIComponent(image.objectKey)}`}
                alt={`写真 ${index + 1}`}
                width={image.width}
                height={image.height}
                loading="lazy"
                className="aspect-square w-full object-cover"
              />
              <Form method="post" className="p-2">
                <CsrfInput token={csrfToken} />
                <input type="hidden" name="intent" value="remove" />
                <input type="hidden" name="imageId" value={image.id} />
                <button type="submit" className="btn btn-danger btn-sm w-full">
                  削除
                </button>
              </Form>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-8">
        <Link to={`/listings/${listingId}/confirm`} className="btn btn-primary">
          確認画面へ戻る
        </Link>
      </div>
    </div>
  );
}
