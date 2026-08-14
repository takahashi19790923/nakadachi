import { Form, Link, redirect } from "react-router";

import { CsrfInput, ErrorSummary, TextField } from "~/components/form";
import { privatePageMeta } from "~/domain/seo";
import { loginVerifySchema } from "~/domain/validation/auth";
import {
  formDataToObject,
  safeRedirectPath,
  toFieldErrors,
} from "~/domain/validation/common";
import { expireCookie, readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { toPublicError } from "~/server/errors";
import { maskEmail } from "~/server/logger.server";
import { createSession } from "~/server/session.server";
import { verifyLoginOtp } from "~/server/services/auth-service.server";
import { recordAccess } from "~/server/services/access-record-service.server";
import { LOGIN_EMAIL_COOKIE } from "./login";
import type { Route } from "./+types/login.verify";
import { getApp } from "~/server/app-context";

export function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const email = readCookie(request, LOGIN_EMAIL_COOKIE);
  // Cookie が無ければ、どのアドレス宛のコードか分からない。最初からやり直す。
  if (!email) throw redirect("/login");

  const url = new URL(request.url);
  return {
    csrfToken: context.csrfToken,
    next: safeRedirectPath(url.searchParams.get("next")),
    // ★画面にも伏せた形でしか出さない。★
    maskedEmail: maskEmail(email),
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("確認コードの入力");
}

export async function action({ request, context: rawContext }: Route.ActionArgs) {
  const context = getApp(rawContext);
  const email = readCookie(request, LOGIN_EMAIL_COOKIE);
  if (!email) throw redirect("/login");

  const formData = await request.formData();

  try {
    assertSameOrigin(request, context.env);
    await verifyCsrfToken(
      context.env,
      formData.get("_csrf"),
      readCookie(request, csrfCookieName(context.env)),
    );

    const parsed = loginVerifySchema.safeParse({
      ...formDataToObject(formData),
      email,
    });
    if (!parsed.success) {
      return { fields: toFieldErrors(parsed.error), message: null };
    }

    const { user, isNewUser } = await verifyLoginOtp({
      db: context.getDb(),
      env: context.env,
      logger: context.logger,
      request,
      email: parsed.data.email,
      otp: parsed.data.otp,
    });

    // ★ログインのたびに新しいセッションを作る（セッション固定攻撃対策）。★
    const { setCookie } = await createSession({
      db: context.getDb(),
      env: context.env,
      userId: user.id,
      request,
    });

    await recordAccess({
      db: context.getDb(),
      env: context.env,
      logger: context.logger,
      request,
      action: isNewUser ? "signup" : "login",
      userId: user.id,
    });

    const next = safeRedirectPath(formData.get("next"), "/mypage");
    const headers = new Headers();
    headers.append("set-cookie", setCookie);
    // 用が済んだアドレスの Cookie は即座に消す。
    headers.append(
      "set-cookie",
      expireCookie(LOGIN_EMAIL_COOKIE, {
        secure: context.env.APP_ORIGIN.startsWith("https://"),
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
      }),
    );

    return redirect(next, { headers });
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.warn("otp verification failed");
    const publicError = toPublicError(error);
    return { fields: publicError.fields ?? null, message: publicError.message };
  }
}

export default function LoginVerify({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { csrfToken, next, maskedEmail } = loaderData;

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <h1 className="text-2xl font-bold text-washi-900">確認コードの入力</h1>
      <p className="mt-2 text-washi-700">
        {maskedEmail} 宛に6桁の確認コードをお送りしました。
        メールに記載のリンクからでもログインできます。
      </p>

      <ErrorSummary message={actionData?.message} fields={actionData?.fields} />

      <Form method="post" className="mt-4">
        <CsrfInput token={csrfToken} />
        <input type="hidden" name="next" value={next} />

        <TextField
          name="otp"
          label="確認コード（6桁）"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          hint="有効期限は15分です。"
        />

        <button type="submit" className="btn btn-primary mt-6 w-full">
          ログインする
        </button>
      </Form>

      <p className="mt-6 text-sm text-washi-600">
        メールが届かない場合は、迷惑メールフォルダをご確認ください。
        <Link to="/login" className="link ml-1">
          アドレスを入力し直す
        </Link>
      </p>
    </div>
  );
}
