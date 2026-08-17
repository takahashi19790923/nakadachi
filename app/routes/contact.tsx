import { Form, Link } from "react-router";

import {
  CsrfInput,
  ErrorSummary,
  TextAreaField,
  TextField,
} from "~/components/form";
import { TurnstileWidget } from "~/components/turnstile";
import { SITE } from "~/config/site";
import { TURNSTILE_FIELD } from "~/domain/form-fields";
import { buildPageMeta } from "~/domain/seo";
import { ulid } from "~/domain/ulid";
import { contactSchema } from "~/domain/validation/interaction";
import { formDataToObject, toFieldErrors,
  formString,
} from "~/domain/validation/common";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { toPublicError } from "~/server/errors";
import { loadUser } from "~/server/guards.server";
import { maskEmail } from "~/server/logger.server";
import { enforceRateLimit } from "~/server/rate-limit.server";
import { sendEmail } from "~/server/services/email/email-service.server";
import { contactInboundEmail } from "~/server/services/email/templates.server";
import { clientIp } from "~/server/session.server";
import { hashIp } from "~/server/crypto.server";
import { requireSecret } from "~/server/env.server";
import { verifyTurnstile } from "~/server/turnstile.server";
import type { Route } from "./+types/contact";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  const user = await loadUser({ request, context });
  return {
    csrfToken: context.csrfToken,
    turnstileSiteKey: context.env.TURNSTILE_SITE_KEY,
    isLoggedIn: user !== null,
    origin: context.env.APP_ORIGIN,
  };
}

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return buildPageMeta({
    title: `お問い合わせ | ${SITE.name}`,
    description:
      "サービスについてのご質問、規約に関するご相談、不具合のご報告はこちらから。",
    path: "/contact",
    origin: loaderData?.origin,
  });
}

export async function action({ request, context: rawContext }: Route.ActionArgs) {
  const context = getApp(rawContext);
  const formData = await request.formData();

  try {
    assertSameOrigin(request, context.env);

    // ★Turnstile は入力検証より前。★ 順序を変えると、外形上 fail-open と
    // 区別がつかなくなる。
    await verifyTurnstile({
      env: context.env,
      token: formData.get(TURNSTILE_FIELD),
      remoteIp: clientIp(request),
      logger: context.logger,
    });

    await verifyCsrfToken(
      context.env,
      formData.get("_csrf"),
      readCookie(request, csrfCookieName(context.env)),
    );

    const ip = clientIp(request);
    if (ip) {
      await enforceRateLimit(
        context.getDb(),
        "contactSend",
        await hashIp(requireSecret(context.env, "SESSION_SECRET"), ip),
      );
    }

    const parsed = contactSchema.safeParse({
      ...formDataToObject(formData),
      turnstileToken: formString(formData, TURNSTILE_FIELD),
    });
    if (!parsed.success) {
      return { fields: toFieldErrors(parsed.error), message: null, sent: false };
    }

    // ★本文をログへ出さない。★ 個人情報が含まれうる。
    // 宛先はマスクした形だけを残す。
    context.logger.info("contact form received", {
      subjectLength: parsed.data.subject.length,
      bodyLength: parsed.data.body.length,
      from: maskEmail(parsed.data.email),
    });

    /*
     * ★運営者へ転送する。★ 送信元ドメインの認証が済むまで転送を止めて
     * いたが、その間も画面は「受け付けました。ご返信します」と出していた。
     * 本文は文字数しか残らず、詐欺の通報も法的な相談も誰にも届かなかった
     * （2026-08-17 の点検で発覚）。送れなかったら成功と言わない。
     *
     * 宛先は EMAIL_REPLY_TO（サポート窓口）。Reply-To を差出人にして、
     * 運営者がそのまま返信できるようにする。
     */
    const delivery = await sendEmail(
      {
        template: "contact_inbound",
        to: context.env.EMAIL_REPLY_TO,
        replyTo: parsed.data.email,
        content: contactInboundEmail({
          fromEmail: parsed.data.email,
          subject: parsed.data.subject,
          body: parsed.data.body,
        }),
        idempotencyKey: `contact_inbound:${ulid()}`,
      },
      { db: context.getDb(), env: context.env, logger: context.logger },
    );

    if (!delivery.sent) {
      // 記録は残っている（email_delivery_logs）。利用者には別の経路を案内する。
      context.logger.error(
        "contact form could not be forwarded",
        new Error(delivery.skipped ?? "send_failed"),
      );
      return {
        fields: null,
        message: `送信できませんでした。お手数ですが ${SITE.supportEmail} へ直接メールでご連絡ください。`,
        sent: false,
      };
    }

    return { fields: null, message: null, sent: true };
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.warn("contact submission failed");
    const publicError = toPublicError(error);
    return {
      fields: publicError.fields ?? null,
      message: publicError.message,
      sent: false,
    };
  }
}

export default function Contact({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { csrfToken, turnstileSiteKey } = loaderData;

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">お問い合わせ</h1>

      <div className="card mt-4 p-4 text-sm text-washi-700">
        <p className="font-semibold text-washi-900">
          お問い合わせの前にご確認ください
        </p>
        <ul className="mt-2 list-inside list-disc space-y-1">
          <li>
            <strong>利用者どうしの取引の仲裁は行っておりません。</strong>
            当サービスは取引の当事者ではありません。
          </li>
          <li>
            規約に反する投稿は、投稿ページの「この投稿を通報する」からお知らせください。
            そちらのほうが早く対応できます。
          </li>
          <li>
            料金については
            <Link to="/legal/tokushoho" className="link mx-1">
              特定商取引法に基づく表記
            </Link>
            をご覧ください。
          </li>
        </ul>
      </div>

      <ErrorSummary message={actionData?.message} fields={actionData?.fields} />

      {actionData?.sent ? (
        <p role="status" className="mt-4 rounded-lg bg-ai-50 p-4 text-ai-900">
          お問い合わせを受け付けました。内容を確認のうえ、
          ご記入いただいたメールアドレス宛にご返信します。
        </p>
      ) : (
        <Form method="post" className="mt-4">
          <CsrfInput token={csrfToken} />

          <TextField
            name="email"
            label="返信先のメールアドレス"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            error={actionData?.fields?.email}
          />

          <TextField
            name="subject"
            label="件名"
            required
            maxLength={120}
            error={actionData?.fields?.subject}
          />

          <TextAreaField
            name="body"
            label="お問い合わせ内容"
            required
            rows={8}
            maxLength={4000}
            error={actionData?.fields?.body}
            hint="他人の個人情報は書かないでください。"
          />

          <TurnstileWidget siteKey={turnstileSiteKey} />

          <button type="submit" className="btn btn-primary mt-6 w-full">
            送信する
          </button>
        </Form>
      )}

      <p className="mt-8 text-sm text-washi-600">
        メールでのご連絡先：{SITE.supportEmail}
      </p>
    </div>
  );
}
