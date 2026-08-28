import { Form } from "react-router";

import { CsrfInput, ErrorSummary } from "~/components/form";
import { privatePageMeta } from "~/domain/seo";
import { formString } from "~/domain/validation/common";
import { getApp } from "~/server/app-context";
import { writeAdminAction } from "~/server/audit.server";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { toPublicError } from "~/server/errors";
import { requireAdminGate } from "~/server/guards.server";
import { getSiteFlags, setSiteFlags } from "~/server/services/site-flags.server";
import type { Route } from "./+types/admin.flags";

/**
 * 運用の切り替えスイッチ。
 *
 * ★事故のときに「止める」手段が、再デプロイしかなかった。★
 * 「掲載の受付だけ止めたい」「登録だけ止めたい」ができず、
 * 手順書にも「Workers のルートを外す」（＝全部止まる）しか無かった。
 *
 * ★ここで止められるのは «サイトは動いているが、ある機能だけ» の場合。★
 * DB ごと落ちているときの全停止は Cloudflare 側で行う（OPERATIONS.md）。
 */

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  await requireAdminGate({ request, context });
  const flags = await getSiteFlags(context.getDb());
  return { csrfToken: context.csrfToken, flags };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("運用スイッチ");
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

    const reason = formString(formData, "reason").trim();
    if (reason === "") {
      return {
        csrfToken: context.csrfToken,
        flags: await getSiteFlags(db),
        message: "理由を入力してください。",
        fields: { reason: "理由は必須です" },
      };
    }

    const next = {
      signupsPaused: formData.get("signupsPaused") === "on",
      listingsPaused: formData.get("listingsPaused") === "on",
      messagesPaused: formData.get("messagesPaused") === "on",
      notice: formString(formData, "notice"),
    };

    const flags = await setSiteFlags(db, admin.id, next);

    /*
     * ★誰が・いつ・なぜ止めたかを残す。★ 止めたことより、
     * 「戻し忘れ」のほうが後から効いてくる。
     */
    await writeAdminAction(db, {
      adminId: admin.id,
      actionType: "site_flags_change",
      targetType: "site",
      targetId: "singleton",
      reason,
      metadata: {
        signupsPaused: next.signupsPaused ? 1 : 0,
        listingsPaused: next.listingsPaused ? 1 : 0,
        messagesPaused: next.messagesPaused ? 1 : 0,
      },
    });

    return { csrfToken: context.csrfToken, flags, saved: true };
  } catch (error) {
    const publicError = toPublicError(error);
    return {
      csrfToken: context.csrfToken,
      flags: await getSiteFlags(db),
      message: publicError.message,
      fields: publicError.fields,
    };
  }
}

const SWITCHES = [
  {
    name: "signupsPaused",
    label: "新規のご登録を止める",
    detail: "既存の利用者のログインは止まりません（管理者も入れます）。",
  },
  {
    name: "listingsPaused",
    label: "新しい投稿の受付と決済を止める",
    detail: "公開中の投稿はそのまま見えます。下書きの保存もできません。",
  },
  {
    name: "messagesPaused",
    label: "メッセージの送信を止める",
    detail: "過去のやり取りは読めます。",
  },
] as const;

export default function AdminFlags({ actionData, loaderData }: Route.ComponentProps) {
  const data = actionData ?? loaderData;
  const flags = data.flags;
  const message = actionData && "message" in actionData ? actionData.message : null;
  const fields = actionData && "fields" in actionData ? actionData.fields : undefined;
  const saved = actionData && "saved" in actionData ? actionData.saved : false;

  const anyPaused =
    flags.signupsPaused || flags.listingsPaused || flags.messagesPaused;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">運用スイッチ</h1>
      <p className="mt-2 text-washi-700">
        事故のときに、サイト全体を止めずに一部だけ止めるためのものです。
        <strong>反映まで最大30秒かかります</strong>（読み込みの間隔）。
      </p>

      {anyPaused && (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 font-semibold text-amber-900">
          ★いま止めている機能があります。★ 戻し忘れにご注意ください。
        </p>
      )}

      {saved && !message && (
        <p className="mt-4 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-green-900">
          保存しました。反映まで最大30秒かかります。
        </p>
      )}

      <ErrorSummary message={message ?? undefined} fields={fields} />

      <Form method="post" className="mt-6 rounded-lg border border-washi-200 p-4">
        <CsrfInput token={data.csrfToken} />

        {SWITCHES.map((s) => (
          <div key={s.name} className="border-b border-washi-100 py-3 last:border-b-0">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                name={s.name}
                defaultChecked={flags[s.name]}
                className="mt-1"
              />
              <span>
                <span className="font-medium text-washi-900">{s.label}</span>
                <span className="mt-1 block text-sm text-washi-600">{s.detail}</span>
              </span>
            </label>
          </div>
        ))}

        <label className="field-label mt-4" htmlFor="notice">
          利用者に出す案内（任意）
        </label>
        <input
          id="notice"
          type="text"
          name="notice"
          maxLength={300}
          defaultValue={flags.notice ?? ""}
          className="field-input"
          placeholder="例：システムの点検のため、本日18時まで新しい投稿の受付を停止しています。"
        />
        <p className="field-hint">
          空のままだと、機能ごとの既定の文言が出ます。
        </p>

        <label className="field-label mt-4" htmlFor="reason">
          理由<span className="ml-1 text-red-700">*</span>
        </label>
        <input
          id="reason"
          type="text"
          name="reason"
          required
          maxLength={500}
          className="field-input"
          placeholder="例：決済の突き合わせで異常を検知したため、原因が分かるまで受付を停止"
        />
        <p className="field-hint">
          記録に残ります。<strong>戻すときも理由が要ります。</strong>
        </p>

        <button type="submit" className="btn btn-primary mt-6">
          保存する
        </button>
      </Form>

      <div className="mt-8 rounded-lg border border-washi-200 bg-washi-50 px-4 py-3 text-sm text-washi-700">
        <p className="font-semibold text-washi-900">サイトごと止めたいときは</p>
        <p className="mt-1">
          ここは<strong>データベースを読んで動いています</strong>。
          データベースごと落ちている場合には使えません。
          全体を止めるときは Cloudflare 側でルートを外してください
          （手順は OPERATIONS.md）。
        </p>
      </div>
    </div>
  );
}
