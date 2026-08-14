import { Link } from "react-router";

import { EmptyState } from "~/components/ui";
import { formatDateTimeJa } from "~/domain/listing-view";
import { formatJpy } from "~/domain/pricing";
import { privatePageMeta } from "~/domain/seo";
import { requireUser } from "~/server/guards.server";
import { listPayments } from "~/server/services/payment/payment-service.server";
import type { Route } from "./+types/mypage.payments";
import { getApp } from "~/server/app-context";

const STATUS_LABEL: Record<string, string> = {
  created: "手続き中",
  pending: "確認中",
  succeeded: "支払い済み",
  failed: "失敗",
  expired: "期限切れ",
  refunded: "返金済み",
  partially_refunded: "一部返金",
  disputed: "申し立て中",
};

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  const payments = await listPayments(context.getDb(), { userId: user.id });

  return {
    payments: payments.map((payment) => ({
      id: payment.id,
      listingId: payment.listingId,
      listingTitle: payment.listingTitle,
      amountJpy: payment.amountJpy,
      status: payment.status,
      paidAt: payment.paidAt?.toISOString() ?? null,
      createdAt: payment.createdAt.toISOString(),
      refundedAmountJpy: payment.refundedAmountJpy,
    })),
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("決済履歴");
}

export default function Payments({ loaderData }: Route.ComponentProps) {
  const { payments } = loaderData;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">決済履歴</h1>
      <p className="mt-2 text-washi-700">
        掲載料は1件110円（税込）のみです。月額料金や成約手数料はありません。
      </p>

      {payments.length === 0 ? (
        <EmptyState
          title="お支払いの記録はありません"
          description="投稿を公開すると、ここに記録が残ります。"
        />
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-sm">
            <caption className="sr-only">お支払いの記録</caption>
            <thead>
              <tr className="border-b border-washi-300 text-left">
                <th scope="col" className="py-2 pr-3">
                  日時
                </th>
                <th scope="col" className="py-2 pr-3">
                  投稿
                </th>
                <th scope="col" className="py-2 pr-3">
                  金額
                </th>
                <th scope="col" className="py-2">
                  状態
                </th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id} className="border-b border-washi-200">
                  <td className="py-3 pr-3 align-top text-washi-700">
                    {formatDateTimeJa(payment.paidAt ?? payment.createdAt)}
                  </td>
                  <td className="py-3 pr-3 align-top">
                    <Link to={`/listings/${payment.listingId}`} className="link">
                      {payment.listingTitle}
                    </Link>
                  </td>
                  <td className="py-3 pr-3 align-top">
                    {formatJpy(payment.amountJpy)}
                    {payment.refundedAmountJpy > 0 ? (
                      <span className="block text-xs text-washi-600">
                        返金 {formatJpy(payment.refundedAmountJpy)}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-3 align-top">
                    {STATUS_LABEL[payment.status] ?? payment.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-6 text-sm text-washi-600">
        領収書が必要な場合は、
        <Link to="/contact" className="link mx-1">
          お問い合わせ
        </Link>
        からご連絡ください。
      </p>
    </div>
  );
}
