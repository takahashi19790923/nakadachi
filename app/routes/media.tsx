import { notFound } from "~/server/errors";
import { getSessionUser, NO_SESSION_RENEWAL } from "~/server/session.server";
import { resolveMediaAccess } from "~/server/services/media/media-service.server";
import type { Route } from "./+types/media";
import { getApp } from "~/server/app-context";

/**
 * 画像の配信。
 *
 * R2 の URL を外へ出さず、必ずこの Worker を通す。そうすることで
 *  - 下書きの画像を所有者と管理者だけに限定できる
 *  - Content-Type をサーバーが決めた値だけに固定できる
 *  - 幅や品質を URL パラメータで指定させない（配信量の踏み台にされない）
 *
 * ★R2 のキーや署名付き URL をログへ出さない。★
 */
export async function loader({ request, context: rawContext, params }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const objectKey = params.objectKey;
  if (!objectKey || objectKey.includes("..")) {
    throw notFound("malformed object key");
  }

  // 閲覧者は Promise のまま渡す。公開中の写真なら待たずに返り、
  // 下書きの写真のときだけ中で待つ（行の問い合わせと並走する）。
  const access = await resolveMediaAccess({
    db: context.getDb(),
    objectKey,
    /*
     * ★写真の配信ではログインの期限を延ばさない。★（監査 PR-D のレビュー）
     * 公開中の写真は共有キャッシュに置く応答なので、Worker は Set-Cookie を足さない
     * （workers/app.ts）。延長を走らせると «DB だけ延びて Cookie は古いまま» になり、
     * 次の画面でも延ばされず、Cookie の期限で先にログアウトする。延長は画面の応答に任せる。
     */
    viewer: getSessionUser({
      getDb: context.getDb,
      env: context.env,
      request,
      renew: NO_SESSION_RENEWAL,
    })
      .then((viewer) => (viewer ? { id: viewer.id, role: viewer.role } : null))
      // 公開中の写真では待たれずに捨てられる。DB が落ちていても未処理の
      // 拒否を残さない。下書きの写真なら「未ログイン」として 404（fail-close）。
      .catch(() => null),
  });

  const object = await context.env.MEDIA.get(access.objectKey);
  if (!object) throw notFound("object missing in storage");

  const headers = new Headers();
  // 保存時に判定した値だけを返す。要求された Content-Type は使わない。
  headers.set("content-type", access.contentType);
  headers.set("x-content-type-options", "nosniff");
  // ダウンロードではなく表示。ファイル名は付けない（利用者の元の名前を持たない）。
  headers.set("content-disposition", "inline");
  headers.set("content-length", String(object.size));
  headers.set("etag", object.httpEtag);
  headers.set(
    "cache-control",
    access.cacheable
      ? // 公開中の投稿の画像。内容は変わらない（差し替えは新しいキーになる）。
        "public, max-age=86400, stale-while-revalidate=604800"
      : // 下書きの画像。共有キャッシュに残さない。
        "private, no-store",
  );
  // 画像を別サイトから直接埋め込ませない。
  headers.set("cross-origin-resource-policy", "same-origin");

  return new Response(object.body, { status: 200, headers });
}
