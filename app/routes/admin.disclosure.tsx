import { Form } from "react-router";

import { CsrfInput, ErrorSummary } from "~/components/form";
import { formatDateTimeJa } from "~/domain/listing-view";
import { privatePageMeta } from "~/domain/seo";
import { formString } from "~/domain/validation/common";
import { getApp } from "~/server/app-context";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { toPublicError } from "~/server/errors";
import { requireAdminGate } from "~/server/guards.server";
import {
  disclosureForTarget,
  disclosureForUser,
} from "~/server/services/access-record-service.server";
import type { Route } from "./+types/admin.disclosure";

/**
 * 発信者情報の取り出し（開示請求・捜査関係事項照会への対応）。
 *
 * ★これが無いまま「開示の求めへお答えできるようにするため」と
 * 公表していた。★ 記録を183日ぶん、復号できる形で持ちながら、
 * 取り出す手段がどこにも無かった（2026-08-25 の公開前監査で発覚）。
 *
 * 無いとどうなるか：請求が来た日に、担当者が本番へ直接つないで
 * その場でコードを書くことになる。★プライバシーポリシーで
 * 「参照した事実は記録に残します」と約束しているのに、
 * その参照がいちばん記録に残らない形で行われる。★
 *
 * ここは3層すべて（メールログイン → 管理者 → 共通の資格情報）を通る。
 * 理由の入力は必須で、記録は access-record-service の中で
 * ★復号する前に★ 書かれる。画面側で書き忘れても記録は残る。
 */

interface Row {
  createdAt: string;
  action: string;
  targetType: string;
  targetId: string;
  ip: string;
  userAgent: string | null;
}

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  await requireAdminGate({ request, context });
  // ★開いただけでは何も引かない。★ 復号は必ず理由つきの送信から。
  return { csrfToken: context.csrfToken };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("発信者情報の取り出し");
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
      formString(formData, "_csrf"),
      readCookie(request, csrfCookieName(context.env)),
    );

    const mode = formString(formData, "mode");
    const reason = formString(formData, "reason");
    const actor = { adminId: admin.id, reason, request };

    let records;
    let subject: string;

    if (mode === "target") {
      const targetType = formString(formData, "targetType");
      const targetId = formString(formData, "targetId");
      subject = `${targetType} / ${targetId}`;
      records = await disclosureForTarget({
        db,
        env: context.env,
        targetType,
        targetId,
        actor,
      });
    } else {
      const userId = formString(formData, "userId");
      subject = `利用者 / ${userId}`;
      records = await disclosureForUser({
        db,
        env: context.env,
        userId,
        actor,
      });
    }

    return {
      csrfToken: context.csrfToken,
      subject,
      rows: records.map(
        (r): Row => ({
          createdAt: r.createdAt.toISOString(),
          action: r.action,
          targetType: r.targetType ?? "",
          targetId: r.targetId ?? "",
          ip: r.ip,
          userAgent: r.userAgent,
        }),
      ),
    };
  } catch (error) {
    const publicError = toPublicError(error);
    return {
      csrfToken: context.csrfToken,
      message: publicError.message,
      fields: publicError.fields,
    };
  }
}

export default function AdminDisclosure({ actionData, loaderData }: Route.ComponentProps) {
  const csrfToken = actionData?.csrfToken ?? loaderData.csrfToken;
  const rows = actionData && "rows" in actionData ? actionData.rows : null;
  const subject = actionData && "subject" in actionData ? actionData.subject : null;
  const message = actionData && "message" in actionData ? actionData.message : null;
  const fields = actionData && "fields" in actionData ? actionData.fields : undefined;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">発信者情報の取り出し</h1>

      <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm">
        <p className="font-semibold text-red-900">
          ここで取り出す情報は、接続元IPアドレスそのものです。
        </p>
        <ul className="mt-2 list-disc pl-5 text-red-900">
          <li>
            <strong>引いた事実は必ず記録に残ります。</strong>
            誰が・いつ・誰のぶんを・なぜ引いたかが監査ログに入ります
            （取り消せません）。
          </li>
          <li>
            正当な目的（法令に基づく開示の求め、捜査関係事項照会、
            重大な不正の調査）以外で使わないでください。
          </li>
          <li>
            取り出した内容を、請求への回答以外の目的で保存・転送しないでください。
          </li>
        </ul>
      </div>

      <ErrorSummary message={message ?? undefined} fields={fields} />

      <Form method="post" className="mt-6 rounded-lg border border-washi-200 p-4">
        <CsrfInput token={csrfToken} />

        <label className="field-label" htmlFor="reason">
          理由<span className="ml-1 text-red-700">*</span>
        </label>
        <textarea
          id="reason"
          name="reason"
          required
          rows={2}
          maxLength={500}
          className="field-input"
          placeholder="例：○○警察署からの捜査関係事項照会（令和8年8月28日付、文書番号…）"
        />
        <p className="field-hint">
          あとから判断の当否を確かめられるように、根拠が分かる書き方にしてください。
        </p>

        <fieldset className="mt-4">
          <legend className="field-label">引く対象</legend>
          <label className="mt-2 flex items-center gap-2">
            <input type="radio" name="mode" value="user" defaultChecked />
            <span>利用者の ID から引く</span>
          </label>
          <input
            type="text"
            name="userId"
            className="field-input mt-1"
            placeholder="利用者 ID（ULID）"
          />

          <label className="mt-4 flex items-center gap-2">
            <input type="radio" name="mode" value="target" />
            <span>投稿・メッセージ・通報から引く</span>
          </label>
          <div className="mt-1 flex gap-2">
            <input
              type="text"
              name="targetType"
              className="field-input"
              placeholder="種別（listing / message / report）"
            />
            <input
              type="text"
              name="targetId"
              className="field-input"
              placeholder="対象の ID"
            />
          </div>
        </fieldset>

        <button type="submit" className="btn btn-primary mt-6">
          記録を残して取り出す
        </button>
      </Form>

      {rows && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-washi-900">
            {subject}（{rows.length} 件）
          </h2>
          {rows.length === 0 ? (
            <p className="mt-2 text-washi-700">
              該当する記録がありません。保存期間（183日）を過ぎている可能性があります。
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[48rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-washi-300 text-left">
                    <th className="py-2 pr-4 font-medium">日時</th>
                    <th className="py-2 pr-4 font-medium">操作</th>
                    <th className="py-2 pr-4 font-medium">対象</th>
                    <th className="py-2 pr-4 font-medium">接続元</th>
                    <th className="py-2 pr-4 font-medium">ブラウザ</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr
                      key={`${row.createdAt}-${i}`}
                      className="border-b border-washi-200 align-top"
                    >
                      <td className="py-2 pr-4 whitespace-nowrap">
                        {formatDateTimeJa(row.createdAt)}
                      </td>
                      <td className="py-2 pr-4">{row.action}</td>
                      <td className="py-2 pr-4">
                        {row.targetType}
                        <span className="block text-washi-600">{row.targetId}</span>
                      </td>
                      <td className="py-2 pr-4 font-mono">{row.ip}</td>
                      <td className="py-2 pr-4 text-washi-600">
                        {row.userAgent ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
