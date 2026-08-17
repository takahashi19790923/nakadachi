import { Form, Link } from "react-router";

import { CsrfInput, ErrorSummary } from "~/components/form";
import { formatDateTimeJa } from "~/domain/listing-view";
import { privatePageMeta } from "~/domain/seo";
import { REPORT_REASON_LABEL } from "~/domain/validation/interaction";
import { writeAdminAction, writeAuditLog } from "~/server/audit.server";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { toPublicError } from "~/server/errors";
import { requireAdminGate } from "~/server/guards.server";
import {
  listReportsForAdmin,
  resolveReport,
} from "~/server/repositories/moderation-repository.server";
import { formString } from "~/domain/validation/common";
import type { Route } from "./+types/admin.reports";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  await requireAdminGate({ request, context });
  const rows = await listReportsForAdmin(context.getDb());

  return {
    csrfToken: context.csrfToken,
    reports: rows.map((row) => ({
      id: row.id,
      targetType: row.targetType,
      targetListingId: row.targetListingId,
      targetUserId: row.targetUserId,
      reason: row.reason,
      detail: row.detail,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      listingTitle: row.listingTitle,
    })),
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("通報一覧（管理）");
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

    const reportId = formString(formData, "reportId");
    const status = formString(formData, "status");
    const note = formString(formData, "note").trim();

    if (status !== "reviewing" && status !== "actioned" && status !== "dismissed") {
      return { message: "対応状態の指定が不正です。" };
    }
    if (note.length < 3) {
      return { message: "対応の記録を3文字以上で入力してください。" };
    }

    // ★当たったかどうかを必ず確かめる。★ 素通りさせると「対応しました」と
    // 出るのに通報は未対応のまま残り、対応漏れが隠れる。
    const resolved = await resolveReport(db, {
      reportId,
      status,
      adminId: admin.id,
      note,
    });
    if (!resolved) {
      return { message: "対象の通報が見つかりませんでした。" };
    }

    await writeAdminAction(db, {
      adminId: admin.id,
      actionType: "report_resolve",
      targetType: "report",
      targetId: reportId,
      reason: note,
      metadata: { status },
    });
    await writeAuditLog(db, context.env, {
      action: "admin.report_resolved",
      actorId: admin.id,
      actorRole: "admin",
      targetType: "report",
      targetId: reportId,
      request,
      metadata: { status },
    });

    return { message: null };
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.error("report resolution failed", error);
    return { message: toPublicError(error).message };
  }
}

export default function AdminReports({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { reports, csrfToken } = loaderData;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">通報一覧（管理）</h1>

      <ErrorSummary message={actionData?.message} />

      <ul className="mt-6 space-y-3">
        {reports.map((report) => (
          <li key={report.id} className="card p-4">
            <p className="text-sm text-washi-600">
              {formatDateTimeJa(report.createdAt)}・状態：{report.status}
            </p>
            <p className="mt-1 font-semibold text-washi-900">
              {REPORT_REASON_LABEL[
                report.reason
              ] ?? report.reason}
            </p>
            {report.listingTitle ? (
              <p className="mt-1 text-sm">
                対象：
                <Link
                  to={`/admin/listings/${report.targetListingId}`}
                  className="link"
                >
                  {report.listingTitle}
                </Link>
              </p>
            ) : null}
            {report.detail ? (
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-washi-800">
                {report.detail}
              </p>
            ) : null}

            <Form method="post" className="mt-3 flex flex-wrap items-end gap-2">
              <CsrfInput token={csrfToken} />
              <input type="hidden" name="reportId" value={report.id} />
              <input
                name="note"
                aria-label="対応の記録"
                placeholder="対応の記録"
                maxLength={500}
                className="field-input mt-0 max-w-xs"
              />
              <button
                type="submit"
                name="status"
                value="actioned"
                className="btn btn-primary btn-sm"
              >
                対応済みにする
              </button>
              <button
                type="submit"
                name="status"
                value="dismissed"
                className="btn btn-secondary btn-sm"
              >
                対応なしにする
              </button>
            </Form>
          </li>
        ))}
      </ul>

      {reports.length === 0 ? (
        <p className="mt-6 text-washi-600">通報はありません。</p>
      ) : null}

      <p className="mt-8 text-sm text-washi-600">
        通報対応で会話の内容を確認した場合も、閲覧の事実が監査ログに記録されます。
      </p>
    </div>
  );
}
