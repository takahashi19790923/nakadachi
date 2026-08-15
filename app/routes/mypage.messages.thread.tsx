import { Form, Link } from "react-router";

import { CsrfInput, ErrorSummary } from "~/components/form";
import { formatDateTimeJa } from "~/domain/listing-view";
import { privatePageMeta } from "~/domain/seo";
import { isUlid } from "~/domain/ulid";
import { messageSchema } from "~/domain/validation/interaction";
import { formDataToObject, toFieldErrors } from "~/domain/validation/common";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { notFound, toPublicError } from "~/server/errors";
import { requireUser } from "~/server/guards.server";
import { enforceRateLimit } from "~/server/rate-limit.server";
import {
  getCounterpartUserId,
  getThreadMessages,
  markThreadRead,
  sendMessage,
} from "~/server/services/message-service.server";
import { notifyNewMessage } from "~/server/services/notification-service.server";
import type { Route } from "./+types/mypage.messages.thread";
import { recordAccess } from "~/server/services/access-record-service.server";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext, params }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  if (!isUlid(params.threadId)) throw notFound("malformed thread id");

  const db = context.getDb();
  const thread = await getThreadMessages({
    db,
    threadId: params.threadId,
    viewerId: user.id,
    // ★管理者であっても、この画面では当事者としてしか見ない。★
    // 通報対応で他人の会話を読むのは管理画面側の経路に限り、監査ログを残す。
    viewerRole: "user",
  });

  context.defer(
    markThreadRead(db, params.threadId, user.id).catch(() => undefined),
  );

  const counterpartId = await getCounterpartUserId(db, params.threadId, user.id);

  return {
    thread,
    viewerId: user.id,
    threadId: params.threadId,
    counterpartId,
    csrfToken: context.csrfToken,
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("メッセージ");
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
    await enforceRateLimit(db, "messageSend", user.id);

    const parsed = messageSchema.safeParse(formDataToObject(formData));
    if (!parsed.success) {
      return { fields: toFieldErrors(parsed.error), message: null };
    }

    // ★送信者はセッションから決める。★ 本文の senderId は受け取らない。
    await sendMessage({
      db,
      threadId: params.threadId,
      senderId: user.id,
      body: parsed.data.body,
    });

    await recordAccess({
      db,
      env: context.env,
      logger: context.logger,
      request,
      action: "message_sent",
      userId: user.id,
      targetType: "thread",
      targetId: params.threadId,
    });

    // 通知は応答を待たせない。失敗しても送信自体は成立している。
    const counterpartId = await getCounterpartUserId(
      db,
      params.threadId,
      user.id,
    );
    if (counterpartId) {
      context.defer(
        notifyNewMessage({
          db,
          env: context.env,
          logger: context.logger,
          threadId: params.threadId,
          recipientId: counterpartId,
        }).catch(() => undefined),
      );
    }

    return { fields: null, message: null };
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.warn("message send failed");
    const publicError = toPublicError(error);
    return { fields: publicError.fields ?? null, message: publicError.message };
  }
}

export default function Thread({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { thread, viewerId, counterpartId, csrfToken } = loaderData;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <p className="text-sm text-washi-600">
        <Link to="/mypage/messages" className="link">
          メッセージ一覧
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold text-washi-900">
        <Link to={`/listings/${thread.listingId}`} className="link">
          {thread.listingTitle}
        </Link>
      </h1>

      <ul className="mt-6 space-y-3">
        {thread.messages.map((message) => {
          const mine = message.senderId === viewerId;
          return (
            <li
              key={message.id}
              className={mine ? "flex justify-end" : "flex justify-start"}
            >
              <div
                className={[
                  "max-w-[85%] rounded-xl px-4 py-3",
                  mine ? "bg-ai-700 text-white" : "bg-white border border-washi-200",
                ].join(" ")}
              >
                <p className={mine ? "text-xs text-ai-100" : "text-xs text-washi-500"}>
                  {message.senderName}・{formatDateTimeJa(message.createdAt)}
                </p>
                {/* 改行のみ反映。HTML としては描かない（XSS 対策） */}
                <p className="mt-1 whitespace-pre-wrap break-words">
                  {message.deleted ? "（このメッセージは削除されました）" : message.body}
                </p>
              </div>
            </li>
          );
        })}
      </ul>

      <ErrorSummary message={actionData?.message} fields={actionData?.fields} />

      <Form method="post" className="mt-6">
        <CsrfInput token={csrfToken} />
        <label className="field-label" htmlFor="message-body">
          メッセージ
        </label>
        <textarea
          id="message-body"
          name="body"
          rows={4}
          maxLength={2000}
          required
          className="field-input"
        />
        <p className="field-hint">
          電話番号・住所・SNSのIDのやり取りは慎重に。前払いを求められた場合はご注意ください。
        </p>
        <button type="submit" className="btn btn-primary mt-3">
          送信する
        </button>
      </Form>

      <div className="mt-8 flex flex-wrap items-center gap-3 text-sm text-washi-600">
        <Link to={`/listings/${thread.listingId}/report`} className="link">
          この投稿を通報する
        </Link>
        {counterpartId ? (
          <Form method="post" action={`/users/${counterpartId}/block`}>
            <CsrfInput token={csrfToken} />
            <input type="hidden" name="intent" value="block" />
            <input type="hidden" name="next" value="/mypage/messages" />
            {/* ブロックしたことは相手に通知しない */}
            <button type="submit" className="link">
              この相手をブロックする
            </button>
          </Form>
        ) : null}
      </div>
    </div>
  );
}
