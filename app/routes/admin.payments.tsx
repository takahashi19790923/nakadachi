import { Form, Link } from "react-router";

import { CsrfInput, ErrorSummary } from "~/components/form";
import { formatDateTimeJa } from "~/domain/listing-view";
import { formatJpy } from "~/domain/pricing";
import { privatePageMeta } from "~/domain/seo";
import { writeAdminAction, writeAuditLog } from "~/server/audit.server";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { toPublicError } from "~/server/errors";
import { requireAdminGate } from "~/server/guards.server";
import {
  listPayments,
  refundPayment,
} from "~/server/services/payment/payment-service.server";
import { formString } from "~/domain/validation/common";
import type { Route } from "./+types/admin.payments";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  await requireAdminGate({ request, context });
  const payments = await listPayments(context.getDb(), { limit: 200 });

  return {
    csrfToken: context.csrfToken,
    payments: payments.map((payment) => ({
      id: payment.id,
      listingId: payment.listingId,
      listingTitle: payment.listingTitle,
      amountJpy: payment.amountJpy,
      currency: payment.currency,
      status: payment.status,
      paidAt: payment.paidAt?.toISOString() ?? null,
      createdAt: payment.createdAt.toISOString(),
      refundedAmountJpy: payment.refundedAmountJpy,
    })),
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("決済状況（管理）");
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

    const paymentId = formString(formData, "paymentId");
    const reason = formString(formData, "reason").trim();
    if (reason.length < 5) {
      return { message: "返金の理由を5文字以上で入力してください。" };
    }

    // ★返金は管理画面から明示的に実行する。★ 非公開化では自動返金しない。
    await refundPayment({
      db,
      env: context.env,
      logger: context.logger,
      paymentId,
      adminId: admin.id,
    });

    await writeAdminAction(db, {
      adminId: admin.id,
      actionType: "payment_refund",
      targetType: "payment",
      targetId: paymentId,
      reason,
    });
    await writeAuditLog(db, context.env, {
      action: "admin.payment_refund_requested",
      actorId: admin.id,
      actorRole: "admin",
      targetType: "payment",
      targetId: paymentId,
      request,
    });

    return {
      message:
        "返金を依頼しました。実際の反映は決済事業者からの通知を受けてから行われます。",
    };
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.error("refund failed", error);
    return { message: toPublicError(error).message };
  }
}

export default function AdminPayments({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { payments, csrfToken } = loaderData;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">決済状況（管理）</h1>

      <ErrorSummary message={actionData?.message} />

      <ul className="mt-6 space-y-2">
        {payments.map((payment) => (
          <li key={payment.id} className="card p-4">
            <p className="text-sm text-washi-600">
              {formatDateTimeJa(payment.paidAt ?? payment.createdAt)}・
              {payment.status}
            </p>
            <p className="mt-1 font-semibold text-washi-900">
              <Link to={`/admin/listings/${payment.listingId}`} className="link">
                {payment.listingTitle}
              </Link>
            </p>
            <p className="mt-1">
              {formatJpy(payment.amountJpy)}（{payment.currency}）
              {payment.refundedAmountJpy > 0
                ? `／返金済み ${formatJpy(payment.refundedAmountJpy)}`
                : ""}
            </p>

            {payment.status === "succeeded" ? (
              <Form method="post" className="mt-3 flex flex-wrap items-end gap-2">
                <CsrfInput token={csrfToken} />
                <input type="hidden" name="paymentId" value={payment.id} />
                <input
                  name="reason"
                  aria-label="返金の理由"
                  placeholder="返金の理由"
                  maxLength={200}
                  className="field-input mt-0 max-w-xs"
                />
                <button type="submit" className="btn btn-danger btn-sm">
                  全額を返金する
                </button>
              </Form>
            ) : null}
          </li>
        ))}
      </ul>

      {payments.length === 0 ? (
        <p className="mt-6 text-washi-600">決済の記録はありません。</p>
      ) : null}

      <p className="mt-8 text-sm text-washi-600">
        全額返金が確定すると、その投稿は自動的に非公開になります
        （返金したのに掲載が続く状態を作らないため）。
      </p>
    </div>
  );
}
