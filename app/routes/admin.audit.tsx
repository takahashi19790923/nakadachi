import { formatDateTimeJa } from "~/domain/listing-view";
import { privatePageMeta } from "~/domain/seo";
import { requireAdminGate } from "~/server/guards.server";
import {
  listAdminActions,
  listAuditLogs,
} from "~/server/repositories/admin-repository.server";
import type { Route } from "./+types/admin.audit";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  await requireAdminGate({ request, context });
  const db = context.getDb();

  const [logs, actions] = await Promise.all([
    listAuditLogs(db),
    listAdminActions(db),
  ]);

  return {
    logs: logs.map((log) => ({
      id: log.id,
      action: log.action,
      actorId: log.actorId,
      actorRole: log.actorRole,
      targetType: log.targetType,
      targetId: log.targetId,
      createdAt: log.createdAt.toISOString(),
    })),
    actions: actions.map((action) => ({
      id: action.id,
      actionType: action.actionType,
      adminId: action.adminId,
      targetType: action.targetType,
      targetId: action.targetId,
      reason: action.reason,
      createdAt: action.createdAt.toISOString(),
    })),
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("監査ログ（管理）");
}

export default function AdminAudit({ loaderData }: Route.ComponentProps) {
  const { logs, actions } = loaderData;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">監査ログ</h1>
      <p className="mt-2 text-sm text-washi-600">
        個人情報は記録していません（IP は鍵付きハッシュ、メールアドレスは記録しない）。
        利用者を削除しても、この記録は残ります。
      </p>

      <section className="mt-8">
        <h2 className="text-lg font-bold">管理操作</h2>
        <ul className="mt-3 space-y-2">
          {actions.map((action) => (
            <li key={action.id} className="card p-3 text-sm">
              <p className="font-semibold text-washi-900">{action.actionType}</p>
              <p className="text-washi-600">
                {formatDateTimeJa(action.createdAt)}・{action.targetType}:
                {action.targetId}
              </p>
              <p className="mt-1 text-washi-800">理由：{action.reason}</p>
            </li>
          ))}
        </ul>
        {actions.length === 0 ? (
          <p className="mt-3 text-washi-600">記録はありません。</p>
        ) : null}
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-bold">監査ログ（全操作）</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <caption className="sr-only">監査ログ</caption>
            <thead>
              <tr className="border-b border-washi-300 text-left">
                <th scope="col" className="py-2 pr-3">
                  日時
                </th>
                <th scope="col" className="py-2 pr-3">
                  操作
                </th>
                <th scope="col" className="py-2 pr-3">
                  実行者
                </th>
                <th scope="col" className="py-2">
                  対象
                </th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-b border-washi-200">
                  <td className="py-2 pr-3 align-top text-washi-700">
                    {formatDateTimeJa(log.createdAt)}
                  </td>
                  <td className="py-2 pr-3 align-top">{log.action}</td>
                  <td className="py-2 pr-3 align-top text-washi-600">
                    {log.actorRole ?? "-"}
                    {log.actorId ? ` (${log.actorId.slice(0, 8)}…)` : ""}
                  </td>
                  <td className="py-2 align-top text-washi-600">
                    {log.targetType ?? "-"}
                    {log.targetId ? `:${log.targetId.slice(0, 8)}…` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
