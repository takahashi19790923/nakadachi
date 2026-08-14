import { Link } from "react-router";

import { privatePageMeta } from "~/domain/seo";
import { LISTING_STATUS_LABEL } from "~/domain/listing-status";
import { requireUser } from "~/server/guards.server";
import { getMypageCounts } from "~/server/services/engagement-service.server";
import { getProfile } from "~/server/repositories/user-repository.server";
import type { Route } from "./+types/mypage";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  const db = context.getDb();

  const [counts, profile] = await Promise.all([
    getMypageCounts(db, user.id),
    getProfile(db, user.id),
  ]);

  return {
    displayName: profile?.displayName ?? "",
    counts,
    isAdmin: user.role === "admin",
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("マイページ");
}

const LINKS: { to: string; label: string; description: string }[] = [
  { to: "/listings/new", label: "投稿をつくる", description: "下書きの保存は無料です" },
  { to: "/mypage/drafts", label: "下書き・決済待ち", description: "公開前の投稿" },
  { to: "/mypage/published", label: "公開中の投稿", description: "掲載中のもの" },
  { to: "/mypage/finished", label: "掲載終了した投稿", description: "終了・期限切れ・非公開" },
  { to: "/mypage/messages", label: "メッセージ", description: "投稿ごとのやり取り" },
  { to: "/mypage/favorites", label: "お気に入り", description: "気になる投稿" },
  { to: "/mypage/payments", label: "決済履歴", description: "お支払いの記録" },
  { to: "/mypage/reports", label: "通報履歴", description: "通報した内容と対応状況" },
  { to: "/mypage/profile", label: "プロフィール編集", description: "表示名・通知設定" },
];

export default function MyPage({ loaderData }: Route.ComponentProps) {
  const { displayName, counts, isAdmin } = loaderData;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">マイページ</h1>
      <p className="mt-1 text-washi-600">{displayName} さん</p>

      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(["draft", "payment_pending", "published", "closed"] as const).map(
          (status) => (
            <div key={status} className="card p-4 text-center">
              <dt className="text-xs text-washi-600">
                {LISTING_STATUS_LABEL[status]}
              </dt>
              <dd className="mt-1 text-2xl font-bold text-ai-800">
                {counts[status] ?? 0}
              </dd>
            </div>
          ),
        )}
      </dl>

      <ul className="mt-6 space-y-2">
        {LINKS.map((link) => (
          <li key={link.to}>
            <Link
              to={link.to}
              className="card flex items-center justify-between p-4 hover:border-ai-300 hover:bg-ai-50"
            >
              <span>
                <span className="font-semibold text-washi-900">{link.label}</span>
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

      {isAdmin ? (
        <p className="mt-6">
          <Link to="/admin" className="link">
            管理者ダッシュボードへ
          </Link>
        </p>
      ) : null}

      <p className="mt-10 text-sm">
        <Link to="/mypage/delete" className="link text-washi-600">
          アカウントを削除する
        </Link>
      </p>
    </div>
  );
}
