import { Form, Link, redirect } from "react-router";

import { SITE } from "~/config/site";
import { CsrfInput, ErrorSummary, TextField } from "~/components/form";
import { TurnstileWidget } from "~/components/turnstile";
import { TURNSTILE_FIELD } from "~/domain/form-fields";
import { privatePageMeta } from "~/domain/seo";
import { loginRequestSchema } from "~/domain/validation/auth";
import {
  formDataToObject,
  safeRedirectPath,
  toFieldErrors,
  formString,
} from "~/domain/validation/common";
import { serializeCookie } from "~/server/cookies.server";
import { assertSameOrigin, verifyCsrfToken } from "~/server/csrf.server";
import { csrfCookieName } from "~/server/csrf.server";
import { readCookie } from "~/server/cookies.server";
import { toPublicError } from "~/server/errors";
import { loadUser } from "~/server/guards.server";
import { requestLoginCode } from "~/server/services/auth-service.server";
import { verifyTurnstile } from "~/server/turnstile.server";
import type { Route } from "./+types/login";
import { getApp } from "~/server/app-context";

/** ログイン中のメールアドレスを次の画面へ渡すための短命な Cookie */
export const LOGIN_EMAIL_COOKIE = "nakadachi_login_email";
const LOGIN_EMAIL_TTL_SECONDS = 15 * 60;

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  // すでにログインしていれば、ログイン画面を見せる意味がない。
  const user = await loadUser({ request, context });
  const url = new URL(request.url);
  const next = safeRedirectPath(url.searchParams.get("next"));
  if (user) throw redirect(next);

  return {
    csrfToken: context.csrfToken,
    turnstileSiteKey: context.env.TURNSTILE_SITE_KEY,
    next,
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("ログイン");
}

export async function action({ request, context: rawContext }: Route.ActionArgs) {
  const context = getApp(rawContext);
  const formData = await request.formData();

  try {
    // ★順序が大事。★
    // 1. Origin の照合（ヘッダだけを見るので安い）
    assertSameOrigin(request, context.env);

    // 2. ★Turnstile はここ。★ 入力検証より前に置く。後ろに置くと、形の崩れた
    //    入力が先に弾かれ、外形上「ボット検査を通っていない」のと区別が
    //    つかなくなる（過去に fail-open と誤診した実例がある）。
    await verifyTurnstile({
      env: context.env,
      token: formData.get(TURNSTILE_FIELD),
      remoteIp: request.headers.get("cf-connecting-ip"),
      logger: context.logger,
    });

    // 3. CSRF トークン
    await verifyCsrfToken(
      context.env,
      formData.get("_csrf"),
      readCookie(request, csrfCookieName(context.env)),
    );

    // 4. 入力検証
    const parsed = loginRequestSchema.safeParse({
      ...formDataToObject(formData),
      turnstileToken: formString(formData, TURNSTILE_FIELD),
    });
    if (!parsed.success) {
      return { fields: toFieldErrors(parsed.error), message: null };
    }

    await requestLoginCode({
      db: context.getDb(),
      env: context.env,
      logger: context.logger,
      request,
      email: parsed.data.email,
    });

    // ★アドレスを URL に載せない。★ 参照元ヘッダやアクセスログに残る。
    // 短命な HttpOnly Cookie で次の画面へ渡す。
    const next = safeRedirectPath(formData.get("next"), "/mypage");
    return redirect(`/login/verify?next=${encodeURIComponent(next)}`, {
      headers: {
        "set-cookie": serializeCookie(LOGIN_EMAIL_COOKIE, parsed.data.email, {
          secure: context.env.APP_ORIGIN.startsWith("https://"),
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
          maxAgeSeconds: LOGIN_EMAIL_TTL_SECONDS,
        }),
      },
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.error("login request failed", error);
    const publicError = toPublicError(error);
    return { fields: publicError.fields ?? null, message: publicError.message };
  }
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const { csrfToken, turnstileSiteKey, next } = loaderData;

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <h1 className="text-2xl font-bold text-washi-900">ログイン</h1>
      <p className="mt-2 text-washi-700">
        メールアドレスに確認コードをお送りします。パスワードはありません。
        はじめての方は、そのままご登録になります（無料）。
      </p>

      <ErrorSummary
        message={actionData?.message}
        fields={actionData?.fields}
      />

      <Form method="post" className="mt-4">
        <CsrfInput token={csrfToken} />
        <input type="hidden" name="next" value={next} />

        <TextField
          name="email"
          label="メールアドレス"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          maxLength={254}
          hint="確認コードをお送りします。"
        />

        <TurnstileWidget siteKey={turnstileSiteKey} />

        <button type="submit" className="btn btn-primary mt-6 w-full">
          確認コードを受け取る
        </button>
      </Form>

      <p className="mt-6 text-sm text-washi-600">
        ログインすると
        <Link to="/legal/terms" className="link mx-1">
          利用規約
        </Link>
        と
        <Link to="/legal/privacy" className="link mx-1">
          プライバシーポリシー
        </Link>
        に同意したものとみなします。
      </p>
      <p className="mt-2 text-sm text-washi-600">
        {SITE.name}の閲覧と会員登録は無料です。
      </p>
    </div>
  );
}
