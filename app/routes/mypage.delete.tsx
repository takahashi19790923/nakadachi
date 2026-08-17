import { Form, Link } from "react-router";

import { CsrfInput, ErrorSummary, TextField } from "~/components/form";
import { formatDateJa } from "~/domain/listing-view";
import { privatePageMeta } from "~/domain/seo";
import { accountDeletionSchema } from "~/domain/validation/auth";
import { formDataToObject, toFieldErrors } from "~/domain/validation/common";
import { writeAuditLog } from "~/server/audit.server";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { toPublicError } from "~/server/errors";
import { requireUser } from "~/server/guards.server";
import { DELETION_GRACE_DAYS } from "~/domain/account";
import {
  cancelAccountDeletion,
  getPendingDeletionRequest,
  requestAccountDeletion,
} from "~/server/repositories/user-repository.server";
import { closeListingsOnDeletionRequest } from "~/server/services/erasure-service.server";
import { notifyAccountDeletionRequested } from "~/server/services/notification-service.server";
import type { Route } from "./+types/mypage.delete";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  const pending = await getPendingDeletionRequest(context.getDb(), user.id);

  return {
    csrfToken: context.csrfToken,
    pending: pending
      ? {
          requestedAt: pending.requestedAt.toISOString(),
          scheduledPurgeAt: pending.scheduledPurgeAt.toISOString(),
        }
      : null,
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("アカウントの削除");
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

    if (formData.get("intent") === "cancel") {
      await cancelAccountDeletion(db, user.id);
      await writeAuditLog(db, context.env, {
        action: "account.deletion_cancelled",
        actorId: user.id,
        request,
      });
      return { fields: null, message: null, done: false };
    }

    const parsed = accountDeletionSchema.safeParse(formDataToObject(formData));
    if (!parsed.success) {
      return { fields: toFieldErrors(parsed.error), message: null, done: false };
    }

    const deletion = await requestAccountDeletion(db, user.id);

    /*
     * ★公開中の投稿はこの時点で止める。★ 画面で「お申し込みの時点で掲載を
     * 終了します」と約束している。以前は関数だけあって呼んでおらず、
     * 嫌がらせが理由で退会する人の掲載に30日間問い合わせが届き続けた
     * （2026-08-17 の点検で発覚）。
     */
    const closed = await closeListingsOnDeletionRequest(db, user.id);

    // ★個人情報を監査ログへ書かない。★ 誰が・いつ の事実だけを残す。
    await writeAuditLog(db, context.env, {
      action: "account.deletion_requested",
      actorId: user.id,
      request,
      metadata: { graceDays: DELETION_GRACE_DAYS, closedListings: closed },
    });

    // 取り消しの案内。応答の外で送る（送れなくても申し込みは成立している）。
    context.defer(
      notifyAccountDeletionRequested({
        db,
        env: context.env,
        logger: context.logger,
        userId: user.id,
        requestId: deletion.id,
        scheduledPurgeAt: deletion.scheduledPurgeAt,
      }).catch((error: unknown) => {
        context.logger.error("account deletion mail failed", error);
      }),
    );

    return { fields: null, message: null, done: true };
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.error("account deletion request failed", error);
    const publicError = toPublicError(error);
    return {
      fields: publicError.fields ?? null,
      message: publicError.message,
      done: false,
    };
  }
}

export default function DeleteAccount({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { csrfToken, pending } = loaderData;

  if (pending || actionData?.done) {
    const purgeDate = pending?.scheduledPurgeAt;
    return (
      <div className="mx-auto w-full max-w-lg px-4 py-10">
        <h1 className="text-2xl font-bold text-washi-900">
          退会のお申し込みを受け付けています
        </h1>
        <p className="mt-4 text-washi-700">
          {purgeDate
            ? `${formatDateJa(purgeDate)}に、アカウントと投稿・メッセージを削除します。`
            : `${DELETION_GRACE_DAYS}日後に、アカウントと投稿・メッセージを削除します。`}
        </p>
        <p className="mt-2 text-washi-700">
          それまではこれまでどおりご利用いただけます。取り消すこともできます。
        </p>

        <Form method="post" className="mt-6">
          <CsrfInput token={csrfToken} />
          <input type="hidden" name="intent" value="cancel" />
          <button type="submit" className="btn btn-primary">
            退会を取り消す
          </button>
        </Form>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-10">
      <h1 className="text-2xl font-bold text-washi-900">アカウントの削除</h1>

      <ErrorSummary message={actionData?.message} fields={actionData?.fields} />

      <div className="card mt-4 border-red-200 bg-red-50 p-4">
        <p className="font-semibold text-red-800">削除するとどうなりますか</p>
        <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-red-900">
          <li>
            お申し込みから{DELETION_GRACE_DAYS}日後に、アカウント・投稿・写真・
            メッセージを削除します。
          </li>
          <li>
            公開中の投稿は、お申し込みの時点で掲載を終了します。
            <strong>退会を取り消しても、終了した掲載は元に戻りません。</strong>
          </li>
          <li>
            <strong>掲載料の返金はありません。</strong>
          </li>
          <li>
            法令で保存が求められる決済の記録は、個人が特定できない形にしたうえで
            保管します。
          </li>
          <li>削除後の復旧はできません。</li>
        </ul>
      </div>

      <Form method="post" className="mt-6">
        <CsrfInput token={csrfToken} />
        <input type="hidden" name="intent" value="request" />

        <TextField
          name="confirmation"
          label="確認のため「退会します」と入力してください"
          required
          error={actionData?.fields?.confirmation}
        />

        <div className="mt-6 flex flex-wrap gap-3">
          <button type="submit" className="btn btn-danger">
            退会を申し込む
          </button>
          <Link to="/mypage" className="btn btn-secondary">
            やめる
          </Link>
        </div>
      </Form>
    </div>
  );
}
