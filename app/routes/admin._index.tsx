import { Link } from "react-router";

import { LISTING_STATUS_LABEL, type ListingStatus } from "~/domain/listing-status";
import { privatePageMeta } from "~/domain/seo";
import { requireAdminGate } from "~/server/guards.server";
import { countUsers } from "~/server/repositories/user-repository.server";
import { countOpenReports } from "~/server/repositories/moderation-repository.server";
import { countListingsByStatus } from "~/server/services/listing-service.server";
import { countFailedWebhooks } from "~/server/services/payment/reconcile-service.server";
import type { Route } from "./+types/admin._index";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  await requireAdminGate({ request, context });
  const db = context.getDb();

  const [listingCounts, userCount, openReports, failedWebhooks] =
    await Promise.all([
      countListingsByStatus(db),
      countUsers(db),
      countOpenReports(db),
      countFailedWebhooks(db),
    ]);

  return { listingCounts, userCount, openReports, failedWebhooks };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("管理者ダッシュボード");
}

const ADMIN_LINKS = [
  { to: "/admin/listings", label: "投稿一覧", description: "公開・非公開の切り替え" },
  { to: "/admin/reports", label: "通報一覧", description: "未対応の通報" },
  {
    to: "/admin/flags",
    label: "運用スイッチ",
    description: "事故のときに、一部の機能だけ止める",
  },
  {
    to: "/admin/disclosure",
    label: "発信者情報の取り出し",
    description: "開示請求・捜査関係事項照会への対応（引いた事実は記録に残る）",
  },
  { to: "/admin/users", label: "ユーザー一覧", description: "利用停止・復帰" },
  { to: "/admin/payments", label: "決済状況", description: "支払い・返金" },
  { to: "/admin/banned-words", label: "禁止ワード管理", description: "遮断・要確認" },
  { to: "/admin/audit", label: "監査ログ", description: "管理操作の記録" },
];

export default function AdminDashboard({ loaderData }: Route.ComponentProps) {
  const { listingCounts, userCount, openReports, failedWebhooks } = loaderData;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">管理者ダッシュボード</h1>

      {/*
        ★決済の取りこぼしを、必ず人の目に触れる場所へ出す。★
        失敗した Webhook には Stripe へ 200 を返しているので、決済事業者の
        画面では成功に見える。ここに出さないと「110円は受け取ったが
        掲載が出ていない」が誰にも分からないまま残る。
      */}
      {failedWebhooks > 0 ? (
        <p className="mt-4 rounded-lg border-2 border-kaki-500 bg-kaki-50 p-4 font-bold text-kaki-900">
          処理できなかった決済通知が {failedWebhooks} 件あります。
          支払い済みなのに公開されていない投稿がある可能性があります。
          <Link to="/admin/payments" className="link ml-2">
            決済状況を確認する
          </Link>
        </p>
      ) : null}

      {openReports > 0 ? (
        <p className="mt-4 rounded-lg border border-kaki-300 bg-kaki-50 p-4 text-kaki-900">
          未対応の通報が {openReports} 件あります。
          <Link to="/admin/reports" className="link ml-2">
            確認する
          </Link>
        </p>
      ) : null}

      <section className="mt-6">
        <h2 className="text-lg font-bold">投稿の状態</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(
            [
              "draft",
              "payment_pending",
              "published",
              "closed",
              "expired",
              "suspended",
              "rejected",
            ] as ListingStatus[]
          ).map((status) => (
            <div key={status} className="card p-4 text-center">
              <dt className="text-xs text-washi-600">
                {LISTING_STATUS_LABEL[status]}
              </dt>
              <dd className="mt-1 text-2xl font-bold text-ai-800">
                {listingCounts[status] ?? 0}
              </dd>
            </div>
          ))}
          <div className="card p-4 text-center">
            <dt className="text-xs text-washi-600">利用者</dt>
            <dd className="mt-1 text-2xl font-bold text-ai-800">{userCount}</dd>
          </div>
        </dl>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-bold">管理メニュー</h2>
        <ul className="mt-3 space-y-2">
          {ADMIN_LINKS.map((link) => (
            <li key={link.to}>
              <Link
                to={link.to}
                className="card flex items-center justify-between p-4 hover:border-ai-300 hover:bg-ai-50"
              >
                <span>
                  <span className="font-semibold text-washi-900">
                    {link.label}
                  </span>
                  <span className="mt-0.5 block text-sm text-washi-600">
                    {link.description}
                  </span>
                </span>
                <span aria-hidden="true" className="text-washi-400">
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-8 text-sm text-washi-600">
        管理操作はすべて監査ログに記録されます。理由の入力は必須です。
      </p>
    </div>
  );
}
