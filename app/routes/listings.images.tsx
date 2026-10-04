import { Form, Link } from "react-router";

import { CsrfInput, ErrorSummary } from "~/components/form";
import { PrivacyWarning } from "~/components/ui";
import { privatePageMeta } from "~/domain/seo";
import { isUlid } from "~/domain/ulid";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { AppError, notFound, toPublicError } from "~/server/errors";
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

/**
 * 本人が写真を足し・消しできる状態。本文の編集（listing-service の updateListing）と
 * そろえる。止められた・終わった投稿は変えさせない。決済の手続き中も変えさせない
 * （払った内容と違う掲載を出さないため。2026-10 のレビュー）。
 */
const PHOTO_EDITABLE_STATUSES: ReadonlySet<string> = new Set(["draft", "published"]);

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
    // ★押すと必ず失敗する操作を出さない★（監査 FN-15 の型）
    editable: PHOTO_EDITABLE_STATUSES.has(listing.status),
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

    // ★所有者の確認を、本文（写真）を読む前に行う。★（監査 SEC-04）
    // 以前は formData を全部読んでから確かめていたので、他人の投稿へ大量に
    // 送りつけるだけで帯域と処理を消費させられた。
    const listing = await getListingForOwner(db, params.listingId);
    if (!listing) throw notFound(`listing not found: ${params.listingId}`);
    assertOwner(listing.ownerId, user);

    /*
     * ★停止・却下・終了した投稿の写真は、本人も変えられない。★（監査 AUTHZ-03）
     * 運営が止めた投稿の写真を本人が消せると、判断の根拠（証拠）が消える。
     */
    if (!PHOTO_EDITABLE_STATUSES.has(listing.status)) {
      throw new AppError("conflict", "この投稿の写真は、いまは変更できません。", {
        detail: `image change on status=${listing.status}`,
      });
    }

    const formData = await request.formData();
    await verifyCsrfToken(
      context.env,
      formData.get("_csrf"),
      readCookie(request, csrfCookieName(context.env)),
    );

    const intent = formString(formData, "intent", "upload");

    /*
     * ★写真を外す操作は数えない。★
     * 外すのは利用者を守る操作（写り込んだものを消したい、など）で、上限に当たった人が
     * 外せなくなるほうが困る（退会の取り消しを数えないのと同じ考え）。行は増えず、
     * 1件の写真は10枚までなので、繰り返しても書き込みは小さい。
     * 一度は «書き込みには上限» として同じ枠で数えたが、反証で «上限に当たると
     * 1時間写真を外せない» と分かって戻した（2026-10-04）。
     */
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
  const { listingId, title, images, editable, csrfToken } = loaderData;

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

      {!editable ? (
        <p className="mt-6 rounded-lg bg-washi-100 p-4 text-washi-800">
          この投稿の写真は、いまは変更できません（写真を変えられるのは、下書きと公開中の投稿です）。
        </p>
      ) : (
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
      )}

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
              {editable ? (
                <Form method="post" className="p-2">
                  <CsrfInput token={csrfToken} />
                  <input type="hidden" name="intent" value="remove" />
                  <input type="hidden" name="imageId" value={image.id} />
                  <button type="submit" className="btn btn-danger btn-sm w-full">
                    削除
                  </button>
                </Form>
              ) : null}
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
