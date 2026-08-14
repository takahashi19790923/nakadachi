import { Form } from "react-router";

import {
  CheckboxField,
  CsrfInput,
  ErrorSummary,
  SelectField,
  TextAreaField,
  TextField,
} from "~/components/form";
import { privatePageMeta } from "~/domain/seo";
import { profileUpdateSchema } from "~/domain/validation/auth";
import { formDataToObject, toFieldErrors } from "~/domain/validation/common";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { toPublicError } from "~/server/errors";
import { requireUser } from "~/server/guards.server";
import { listPrefectures } from "~/server/repositories/location-repository.server";
import {
  getProfile,
  updateProfile,
} from "~/server/repositories/user-repository.server";
import type { Route } from "./+types/mypage.profile";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  const db = context.getDb();
  const [profile, prefectures] = await Promise.all([
    getProfile(db, user.id),
    listPrefectures(db),
  ]);

  return {
    profile,
    prefectures: prefectures.map((row) => ({ code: row.code, name: row.name })),
    csrfToken: context.csrfToken,
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("プロフィール編集");
}

export async function action({ request, context: rawContext }: Route.ActionArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  const formData = await request.formData();

  try {
    assertSameOrigin(request, context.env);
    await verifyCsrfToken(
      context.env,
      formData.get("_csrf"),
      readCookie(request, csrfCookieName(context.env)),
    );

    const parsed = profileUpdateSchema.safeParse(formDataToObject(formData));
    if (!parsed.success) {
      return { fields: toFieldErrors(parsed.error), message: null, saved: false };
    }

    await updateProfile(context.getDb(), user.id, {
      displayName: parsed.data.displayName,
      bio: parsed.data.bio,
      prefectureCode: parsed.data.prefectureCode,
      cityCode: undefined,
      // チェックが外れていると項目自体が送られてこない。
      notifyOnMessage: formData.get("notifyOnMessage") !== null,
      notifyOnExpiry: formData.get("notifyOnExpiry") !== null,
    });

    return { fields: null, message: null, saved: true };
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.error("profile update failed", error);
    const publicError = toPublicError(error);
    return {
      fields: publicError.fields ?? null,
      message: publicError.message,
      saved: false,
    };
  }
}

export default function Profile({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { profile, prefectures, csrfToken } = loaderData;

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">プロフィール編集</h1>
      <p className="mt-2 text-sm text-washi-600">
        表示名は投稿の詳細ページに出ます。本名を使う必要はありません。
        メールアドレスは公開されません。
      </p>

      <ErrorSummary message={actionData?.message} fields={actionData?.fields} />
      {actionData?.saved ? (
        <p role="status" className="mt-4 rounded-lg bg-ai-50 p-3 text-ai-900">
          保存しました。
        </p>
      ) : null}

      <Form method="post" className="mt-4">
        <CsrfInput token={csrfToken} />

        <TextField
          name="displayName"
          label="表示名"
          required
          maxLength={40}
          defaultValue={profile?.displayName ?? ""}
          error={actionData?.fields?.displayName}
        />

        <TextAreaField
          name="bio"
          label="自己紹介"
          rows={4}
          maxLength={400}
          defaultValue={profile?.bio ?? ""}
          error={actionData?.fields?.bio}
          hint="取引の際に伝えたいことなど。連絡先は書かないでください。"
        />

        <SelectField
          name="prefectureCode"
          label="よく使う地域"
          placeholder="指定しない"
          defaultValue={profile?.prefectureCode ?? ""}
          options={prefectures.map((prefecture) => ({
            value: prefecture.code,
            label: prefecture.name,
          }))}
          hint="投稿フォームの初期値に使います。公開はされません。"
        />

        <fieldset className="mt-6">
          <legend className="field-label">メール通知</legend>
          <CheckboxField
            name="notifyOnMessage"
            label="新しいメッセージが届いたら知らせる"
            defaultChecked={profile?.notifyOnMessage ?? true}
          />
          <CheckboxField
            name="notifyOnExpiry"
            label="掲載期間の終了が近づいたら知らせる"
            defaultChecked={profile?.notifyOnExpiry ?? true}
          />
        </fieldset>

        <button type="submit" className="btn btn-primary mt-6">
          保存する
        </button>
      </Form>
    </div>
  );
}
