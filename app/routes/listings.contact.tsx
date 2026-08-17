import { redirect } from "react-router";

import { isUlid } from "~/domain/ulid";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { notFound, toPublicError } from "~/server/errors";
import { requireUser } from "~/server/guards.server";
import { ensureThread } from "~/server/services/message-service.server";
import type { Route } from "./+types/listings.contact";
import { getApp } from "~/server/app-context";

/**
 * 投稿への問い合わせ。会話スレッドを用意してメッセージ画面へ送る。
 *
 * GET でも POST でも受ける。詳細ページからはリンク（GET）で来るが、
 * ★スレッドを作るだけで通知もメッセージも発生しない★ので、
 * 先読みで踏まれても実害が無い（同じ人・同じ投稿なら常に同じ1本になる）。
 */
export async function loader({ request, context: rawContext, params }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  if (!isUlid(params.listingId)) throw notFound("malformed id");

  try {
    const { threadId } = await ensureThread({
      db: context.getDb(),
      listingId: params.listingId,
      inquirerId: user.id,
    });
    return redirect(`/mypage/messages/${threadId}`);
  } catch (error) {
    /*
     * ★通常の断り（自分の投稿・公開中でない・ブロック中）を 500 にしない。★
     * ensureThread はこれらを AppError（Response ではない）で返す。捕まえずに
     * 投げると React Router は一律 500 にし、この画面の本文
     * 「お問い合わせできませんでした」ではなく root の ErrorBoundary が出る
     * （画面には「エラー 409」、実際の応答は 500）。action 側と同じ形にする。
     */
    if (error instanceof Response) throw error;
    context.logger.warn("contact failed");
    return { message: toPublicError(error).message };
  }
}

export async function action({ request, context: rawContext, params }: Route.ActionArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  if (!isUlid(params.listingId)) throw notFound("malformed id");
  const formData = await request.formData();

  try {
    assertSameOrigin(request, context.env);
    await verifyCsrfToken(
      context.env,
      formData.get("_csrf"),
      readCookie(request, csrfCookieName(context.env)),
    );

    const { threadId } = await ensureThread({
      db: context.getDb(),
      listingId: params.listingId,
      inquirerId: user.id,
    });

    return redirect(`/mypage/messages/${threadId}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.warn("contact failed");
    return { message: toPublicError(error).message };
  }
}

export default function Contact({ loaderData, actionData }: Route.ComponentProps) {
  const message = actionData?.message ?? loaderData?.message;
  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <h1 className="text-xl font-bold text-washi-900">
        お問い合わせできませんでした
      </h1>
      <p className="mt-4 text-washi-700">
        {message ?? "時間をおいてお試しください。"}
      </p>
    </div>
  );
}
