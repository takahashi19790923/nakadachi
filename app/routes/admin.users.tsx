import { Form } from "react-router";

import { CsrfInput, ErrorSummary } from "~/components/form";
import { formatDateTimeJa } from "~/domain/listing-view";
import { privatePageMeta } from "~/domain/seo";
import { isUlid } from "~/domain/ulid";
import { writeAdminAction, writeAuditLog } from "~/server/audit.server";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { AppError, toPublicError } from "~/server/errors";
import { requireAdminGate } from "~/server/guards.server";
import {
  listUsersForAdmin,
  setUserStatus,
} from "~/server/repositories/user-repository.server";
import { revokeAllSessions } from "~/server/session.server";
import { formString } from "~/domain/validation/common";
import type { Route } from "./+types/admin.users";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  await requireAdminGate({ request, context });
  const rows = await listUsersForAdmin(context.getDb());

  return {
    csrfToken: context.csrfToken,
    users: rows.map((row) => ({
      id: row.id,
      role: row.role,
      status: row.status,
      // ★メールアドレスは復号しない。★ 画面に出す用途が無い。
      displayName: row.displayName ?? "（未設定）",
      createdAt: row.createdAt.toISOString(),
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      suspendedReason: row.suspendedReason,
    })),
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("ユーザー一覧（管理）");
}

export async function action({ request, context: rawContext }: Route.ActionArgs) {
  const context = getApp(rawContext);
  const admin = await requireAdminGate({ request, context });
  const db = context.getDb();
  const formData = await request.formData();

  try {
    assertSameOrigin(request, context.env);
    await verifyCsrfToken(
      context.env,
      formData.get("_csrf"),
      readCookie(request, csrfCookieName(context.env)),
    );

    const userId = formString(formData, "userId");
    if (!isUlid(userId)) {
      throw new AppError("validation_failed", "対象が不正です。", {
        detail: "malformed user id",
      });
    }
    if (userId === admin.id) {
      return {
        message: "自分自身の利用を停止することはできません。",
        fields: null,
      };
    }

    const intent = formData.get("intent") === "restore" ? "restore" : "suspend";
    const reason = formString(formData, "reason").trim();
    if (intent === "suspend" && reason.length < 5) {
      return { message: "停止の理由を5文字以上で入力してください。", fields: null };
    }

    /*
     * ★当たったかどうかを必ず確かめる。★ ULID として正しくても、その
     * 利用者が居るとは限らない。素通りさせると下の記録だけが残り、
     * 「停止した」という嘘の履歴ができる。
     */
    const changed = await setUserStatus(db, {
      userId,
      status: intent === "restore" ? "active" : "suspended",
      reason: intent === "restore" ? null : reason,
    });
    if (!changed) {
      throw new AppError("not_found", "対象の利用者が見つかりませんでした。", {
        detail: `user not found for admin ${intent}: ${userId}`,
      });
    }

    // ★停止したら、その場で全セッションを失効させる。★
    // 止めても入ったままでは意味がない。
    if (intent === "suspend") {
      await revokeAllSessions(db, userId);
    }

    await writeAdminAction(db, {
      adminId: admin.id,
      actionType: intent === "restore" ? "user_restore" : "user_suspend",
      targetType: "user",
      targetId: userId,
      reason: reason || "（復帰）",
    });
    await writeAuditLog(db, context.env, {
      action: `admin.user_${intent}`,
      actorId: admin.id,
      actorRole: "admin",
      targetType: "user",
      targetId: userId,
      request,
    });

    return { message: null, fields: null };
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.error("admin user action failed", error);
    const publicError = toPublicError(error);
    return { message: publicError.message, fields: publicError.fields ?? null };
  }
}

export default function AdminUsers({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { users, csrfToken } = loaderData;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">ユーザー一覧（管理）</h1>
      <p className="mt-2 text-sm text-washi-600">
        メールアドレスは暗号化して保存しており、この画面には表示されません。
      </p>
      <p className="mt-2 text-sm text-washi-700">
        利用を停止すると、<strong>その人の掲載はすべて公開ページから消え、
        ログイン中の端末もその場で切断されます。</strong>
        再開すると掲載も元に戻ります（掲載料の返金は行われません）。
      </p>

      <ErrorSummary message={actionData?.message} fields={actionData?.fields} />

      <ul className="mt-6 space-y-2">
        {users.map((user) => (
          <li key={user.id} className="card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-washi-900">
                {user.displayName}
              </span>
              {user.role === "admin" ? (
                <span className="rounded-full bg-ai-100 px-2 py-0.5 text-xs font-bold text-ai-900">
                  管理者
                </span>
              ) : null}
              {user.status === "suspended" ? (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800">
                  停止中
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-washi-600">
              登録 {formatDateTimeJa(user.createdAt)}
              {user.lastLoginAt
                ? `・最終ログイン ${formatDateTimeJa(user.lastLoginAt)}`
                : ""}
            </p>
            {user.suspendedReason ? (
              <p className="mt-1 text-sm text-red-700">
                停止理由：{user.suspendedReason}
              </p>
            ) : null}

            <Form method="post" className="mt-3 flex flex-wrap items-end gap-2">
              <CsrfInput token={csrfToken} />
              <input type="hidden" name="userId" value={user.id} />
              {user.status === "suspended" ? (
                <button
                  type="submit"
                  name="intent"
                  value="restore"
                  className="btn btn-secondary btn-sm"
                >
                  利用を再開する
                </button>
              ) : (
                <>
                  <input
                    name="reason"
                    aria-label={`${user.displayName} を停止する理由`}
                    placeholder="停止の理由"
                    maxLength={200}
                    className="field-input mt-0 max-w-xs"
                  />
                  <button
                    type="submit"
                    name="intent"
                    value="suspend"
                    className="btn btn-danger btn-sm"
                  >
                    利用を停止する
                  </button>
                </>
              )}
            </Form>
          </li>
        ))}
      </ul>
    </div>
  );
}
