import { EmptyState } from "~/components/ui";
import { formatDateTimeJa } from "~/domain/listing-view";
import { privatePageMeta } from "~/domain/seo";
import { REPORT_REASON_LABEL } from "~/domain/validation/interaction";
import { requireUser } from "~/server/guards.server";
import { listReportsByReporter } from "~/server/repositories/moderation-repository.server";
import type { Route } from "./+types/mypage.reports";
import { getApp } from "~/server/app-context";

const STATUS_LABEL: Record<string, string> = {
  open: "確認待ち",
  reviewing: "確認中",
  actioned: "対応済み",
  dismissed: "対応なし",
};

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  const reports = await listReportsByReporter(context.getDb(), user.id);
  const submitted =
    new URL(request.url).searchParams.get("submitted") === "1";

  return {
    reports: reports.map((report) => ({
      id: report.id,
      reason: report.reason,
      status: report.status,
      createdAt: report.createdAt.toISOString(),
      listingId: report.targetListingId,
    })),
    submitted,
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("通報履歴");
}

export default function Reports({ loaderData }: Route.ComponentProps) {
  const { reports, submitted } = loaderData;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">通報履歴</h1>

      {submitted ? (
        <p role="status" className="mt-4 rounded-lg bg-ai-50 p-4 text-ai-900">
          通報を受け付けました。内容は運営者が確認します。
          対応の結果を個別にお伝えできない場合があります。
        </p>
      ) : null}

      {reports.length === 0 ? (
        <EmptyState
          title="通報した履歴はありません"
          description="規約に反する投稿を見つけたら、投稿ページから通報できます。"
        />
      ) : (
        <ul className="mt-4 space-y-2">
          {reports.map((report) => (
            <li key={report.id} className="card p-4">
              <p className="font-semibold text-washi-900">
                {REPORT_REASON_LABEL[
                  report.reason
                ] ?? report.reason}
              </p>
              <p className="mt-1 text-sm text-washi-600">
                {formatDateTimeJa(report.createdAt)}・状態：
                {STATUS_LABEL[report.status] ?? report.status}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
