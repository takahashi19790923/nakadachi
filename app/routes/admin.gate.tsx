import { Form, redirect } from "react-router";

import { CsrfInput, ErrorSummary, TextField } from "~/components/form";
import { privatePageMeta } from "~/domain/seo";
import { safeRedirectPath, toFieldErrors,
  formString,
} from "~/domain/validation/common";
import { adminGateSchema } from "~/domain/validation/auth";
import { formDataToObject } from "~/domain/validation/common";
import { writeAuditLog } from "~/server/audit.server";
import {
  checkGateCredentials,
  hasValidGate,
  issueGateCookie,
} from "~/server/admin-gate.server";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { toPublicError } from "~/server/errors";
import { requireAdmin } from "~/server/guards.server";
import { enforceRateLimit } from "~/server/rate-limit.server";
import {
  sendAdminReauthCode,
  verifyAdminReauthCode,
} from "~/server/services/admin-auth-service.server";
import type { Route } from "./+types/admin.gate";
import { getApp } from "~/server/app-context";

/**
 * 管理画面の入口（第2層と第3層）。
 *
 * ★ブラウザの Basic 認証ダイアログを使わない。★
 * 管理画面は fetch で API を呼ぶ作りなので、401 に対して資格情報の窓が出ず、
 * 正しい値を知っていても入れなくなる。curl では通るため、実装者は
 * 「動いた」と誤認する（別サービスで実際に起きた）。
 * 守る強さは変えず、同じ資格情報を画面内の入力欄で受ける。
 */
export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  await requireAdmin({ request, context });

  const url = new URL(request.url);
  const next = safeRedirectPath(url.searchParams.get("next"), "/admin");

  // すでに通過証を持っていれば、そのまま先へ。
  if (await hasValidGate(request, context.env)) {
    throw redirect(next);
  }

  return { csrfToken: context.csrfToken, next };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("管理画面の認証");
}

export async function action({ request, context: rawContext }: Route.ActionArgs) {
  const context = getApp(rawContext);
  const admin = await requireAdmin({ request, context });
  const db = context.getDb();
  const formData = await request.formData();

  try {
    assertSameOrigin(request, context.env);
    await verifyCsrfToken(
      context.env,
      formData.get("_csrf"),
      readCookie(request, csrfCookieName(context.env)),
    );
    await enforceRateLimit(db, "adminGate", admin.id);

    if (formData.get("intent") === "send_code") {
      await sendAdminReauthCode({
        db,
        env: context.env,
        logger: context.logger,
        adminId: admin.id,
      });
      return { fields: null, message: null, codeSent: true };
    }

    // ── 第2層：管理者だけの再認証（メール OTP）──────────────
    const otp = formString(formData, "otp");
    await verifyAdminReauthCode({ db, env: context.env, adminId: admin.id, otp });

    // ── 第3層：全プロジェクト共通の追加資格情報 ────────────
    const parsed = adminGateSchema.safeParse(formDataToObject(formData));
    if (!parsed.success) {
      return {
        fields: toFieldErrors(parsed.error),
        message: null,
        codeSent: true,
      };
    }

    const result = await checkGateCredentials(
      context.env,
      parsed.data.user,
      parsed.data.pass,
    );

    if (!result.ok) {
      // ★未設定でも通さない（fail-close）。★ 素通りにすると第3層が黙って消える。
      context.logger.warn("admin gate rejected", { reason: result.reason });
      await writeAuditLog(db, context.env, {
        action: "admin.gate_failed",
        actorId: admin.id,
        actorRole: "admin",
        request,
        metadata: { reason: result.reason },
      });
      return {
        fields: { pass: "利用者名またはパスワードが正しくありません" },
        message: null,
        codeSent: true,
      };
    }

    await writeAuditLog(db, context.env, {
      action: "admin.gate_passed",
      actorId: admin.id,
      actorRole: "admin",
      request,
    });

    const next = safeRedirectPath(formData.get("next"), "/admin");
    return redirect(next, {
      headers: { "set-cookie": await issueGateCookie(context.env) },
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.warn("admin gate error");
    const publicError = toPublicError(error);
    return {
      fields: publicError.fields ?? null,
      message: publicError.message,
      codeSent: true,
    };
  }
}

export default function AdminGate({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { csrfToken, next } = loaderData;

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <h1 className="text-2xl font-bold text-washi-900">管理画面の認証</h1>
      <p className="mt-2 text-sm text-washi-600">
        管理データに触れるには、メールでの再確認と、追加の資格情報の両方が必要です。
      </p>

      <ErrorSummary message={actionData?.message} fields={actionData?.fields} />

      <Form method="post" className="mt-6">
        <CsrfInput token={csrfToken} />
        <input type="hidden" name="intent" value="send_code" />
        <button type="submit" className="btn btn-secondary w-full">
          確認コードをメールで受け取る
        </button>
      </Form>

      {actionData?.codeSent ? (
        <p role="status" className="mt-3 rounded-lg bg-ai-50 p-3 text-sm text-ai-900">
          登録のアドレスへ確認コードを送りました（有効期限10分）。
        </p>
      ) : null}

      <Form method="post" className="mt-8 border-t border-washi-200 pt-6">
        <CsrfInput token={csrfToken} />
        <input type="hidden" name="intent" value="verify" />
        <input type="hidden" name="next" value={next} />

        <TextField
          name="otp"
          label="メールの確認コード（6桁）"
          inputMode="numeric"
          maxLength={6}
          required
          error={actionData?.fields?.otp}
        />
        <TextField
          name="user"
          label="管理用の利用者名"
          autoComplete="off"
          required
          error={actionData?.fields?.user}
        />
        <TextField
          name="pass"
          label="管理用のパスワード"
          type="password"
          autoComplete="off"
          required
          error={actionData?.fields?.pass}
        />

        <button type="submit" className="btn btn-primary mt-6 w-full">
          管理画面に入る
        </button>
      </Form>
    </div>
  );
}
