import { Form } from "react-router";

import { CsrfInput, ErrorSummary } from "~/components/form";
import { formatDateTimeJa } from "~/domain/listing-view";
import { privatePageMeta } from "~/domain/seo";
import { writeAdminAction } from "~/server/audit.server";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { toPublicError } from "~/server/errors";
import { requireAdminGate } from "~/server/guards.server";
import {
  addBannedWord,
  listBannedWords,
  removeBannedWord,
} from "~/server/repositories/moderation-repository.server";
import { formString } from "~/domain/validation/common";
import type { Route } from "./+types/admin.banned-words";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  await requireAdminGate({ request, context });
  const words = await listBannedWords(context.getDb());

  return {
    csrfToken: context.csrfToken,
    words: words.map((word) => ({
      id: word.id,
      word: word.word,
      severity: word.severity,
      note: word.note,
      createdAt: word.createdAt.toISOString(),
    })),
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("禁止ワード管理");
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

    const intent = formString(formData, "intent", "add");

    if (intent === "remove") {
      const id = formString(formData, "id");
      await removeBannedWord(db, id);
      await writeAdminAction(db, {
        adminId: admin.id,
        actionType: "banned_word_remove",
        targetType: "banned_word",
        targetId: id,
        reason: "管理画面からの削除",
      });
      return { message: null };
    }

    const word = formString(formData, "word").trim();
    if (word.length < 2) {
      return { message: "2文字以上の語句を入力してください。" };
    }

    const severity = formData.get("severity") === "block" ? "block" : "flag";
    await addBannedWord(db, {
      word,
      severity,
      note: formString(formData, "note").trim() || undefined,
      createdBy: admin.id,
    });

    await writeAdminAction(db, {
      adminId: admin.id,
      actionType: "banned_word_add",
      targetType: "banned_word",
      // ★語そのものを監査ログの対象IDに入れない。★ 差別的な語を扱うため。
      targetId: `${severity}:${word.length}chars`,
      reason: "管理画面からの追加",
    });

    return { message: null };
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.error("banned word action failed", error);
    return { message: toPublicError(error).message };
  }
}

export default function BannedWords({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { words, csrfToken } = loaderData;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">禁止ワード管理</h1>
      <p className="mt-2 text-sm text-washi-600">
        「遮断」は投稿・メッセージを拒否します。「要確認」は通したうえで
        管理者の確認対象にします。表記ゆれで簡単にすり抜けるため、
        これだけに頼らず通報と目視を併用してください。
      </p>

      <ErrorSummary message={actionData?.message} />

      <Form method="post" className="card mt-6 p-4">
        <CsrfInput token={csrfToken} />
        <input type="hidden" name="intent" value="add" />

        <label className="field-label" htmlFor="word">
          語句
        </label>
        <input
          id="word"
          name="word"
          maxLength={60}
          required
          className="field-input"
        />

        <label className="field-label mt-3" htmlFor="severity">
          扱い
        </label>
        <select id="severity" name="severity" className="field-input">
          <option value="flag">要確認</option>
          <option value="block">遮断</option>
        </select>

        <label className="field-label mt-3" htmlFor="note">
          メモ
        </label>
        <input id="note" name="note" maxLength={200} className="field-input" />

        <button type="submit" className="btn btn-primary mt-4">
          追加する
        </button>
      </Form>

      <ul className="mt-6 space-y-2">
        {words.map((word) => (
          <li
            key={word.id}
            className="card flex flex-wrap items-center justify-between gap-3 p-3"
          >
            <div>
              <p className="font-mono text-washi-900">{word.word}</p>
              <p className="text-xs text-washi-600">
                {word.severity === "block" ? "遮断" : "要確認"}・
                {formatDateTimeJa(word.createdAt)}
                {word.note ? `・${word.note}` : ""}
              </p>
            </div>
            <Form method="post">
              <CsrfInput token={csrfToken} />
              <input type="hidden" name="intent" value="remove" />
              <input type="hidden" name="id" value={word.id} />
              <button type="submit" className="btn btn-secondary btn-sm">
                削除
              </button>
            </Form>
          </li>
        ))}
      </ul>
    </div>
  );
}
