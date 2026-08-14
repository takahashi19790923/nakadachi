import { Link } from "react-router";

import { EmptyState } from "~/components/ui";
import { formatDateTimeJa } from "~/domain/listing-view";
import { privatePageMeta } from "~/domain/seo";
import { requireUser } from "~/server/guards.server";
import { listThreadsForUser } from "~/server/services/message-service.server";
import type { Route } from "./+types/mypage.messages";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  const threads = await listThreadsForUser(context.getDb(), user.id);
  return { threads };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("メッセージ");
}

export default function Messages({ loaderData }: Route.ComponentProps) {
  const { threads } = loaderData;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">メッセージ</h1>

      {threads.length === 0 ? (
        <EmptyState
          title="やり取りはまだありません"
          description="気になる投稿から「投稿者に問い合わせる」を押すと、ここに会話が並びます。"
          actionLabel="投稿をさがす"
          actionTo="/search"
        />
      ) : (
        <ul className="mt-4 space-y-2">
          {threads.map((thread) => (
            <li key={thread.id}>
              <Link
                to={`/mypage/messages/${thread.id}`}
                className="card block p-4 hover:border-ai-300 hover:bg-ai-50"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-semibold text-washi-900">
                    {thread.listingTitle}
                  </p>
                  {thread.unread ? (
                    <span className="shrink-0 rounded-full bg-kaki-600 px-2 py-0.5 text-xs font-bold text-white">
                      未読
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-washi-600">
                  相手：{thread.counterpartName}
                </p>
                <p className="mt-1 text-xs text-washi-500">
                  {thread.lastMessageAt
                    ? formatDateTimeJa(thread.lastMessageAt)
                    : "まだメッセージはありません"}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
