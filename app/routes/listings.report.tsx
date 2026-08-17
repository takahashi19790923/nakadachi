import { Form, Link, redirect } from "react-router";

import {
  CsrfInput,
  ErrorSummary,
  RadioGroupField,
  TextAreaField,
} from "~/components/form";
import { privatePageMeta } from "~/domain/seo";
import { isUlid } from "~/domain/ulid";
// 表示名は依存を持たないファイルから。検証スキーマ（zod）は action だけが
// 使うので別の import にしておく。1つの import にまとめると、React Router が
// action を落としたあとも zod がクライアントへ残る。
import { REPORT_REASONS, REPORT_REASON_LABEL } from "~/domain/report-reasons";
import { reportSchema } from "~/domain/validation/interaction";
import { formDataToObject, toFieldErrors } from "~/domain/validation/common";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { notFound, toPublicError } from "~/server/errors";
import { requireUser } from "~/server/guards.server";
import { enforceRateLimit } from "~/server/rate-limit.server";
import { getPublishedListing } from "~/server/repositories/listing-repository.server";
import { createReport } from "~/server/repositories/moderation-repository.server";
import { recordAccess } from "~/server/services/access-record-service.server";
import type { Route } from "./+types/listings.report";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext, params }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  await requireUser({ request, context });
  if (!isUlid(params.listingId)) throw notFound("malformed id");

  const listing = await getPublishedListing(context.getDb(), params.listingId);
  if (!listing) throw notFound(`listing not visible: ${params.listingId}`);

  return {
    listingId: listing.id,
    title: listing.title,
    csrfToken: context.csrfToken,
  };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("投稿を通報する");
}

export async function action({ request, context: rawContext, params }: Route.ActionArgs) {
  const context = getApp(rawContext);
  const user = await requireUser({ request, context });
  const db = context.getDb();
  const formData = await request.formData();

  try {
    assertSameOrigin(request, context.env);
    await verifyCsrfToken(
      context.env,
      formData.get("_csrf"),
      readCookie(request, csrfCookieName(context.env)),
    );
    await enforceRateLimit(db, "reportCreate", user.id);

    const parsed = reportSchema.safeParse(formDataToObject(formData));
    if (!parsed.success) {
      return { fields: toFieldErrors(parsed.error), message: null, done: false };
    }

    await createReport(db, {
      reporterId: user.id,
      target: { type: "listing", id: params.listingId },
      reason: parsed.data.reason,
      detail: parsed.data.detail,
    });

    await recordAccess({
      db,
      env: context.env,
      logger: context.logger,
      request,
      action: "report_submitted",
      userId: user.id,
      targetType: "listing",
      targetId: params.listingId,
    });

    return redirect("/mypage/reports?submitted=1");
  } catch (error) {
    if (error instanceof Response) throw error;
    context.logger.warn("report submission failed");
    const publicError = toPublicError(error);
    return {
      fields: publicError.fields ?? null,
      message: publicError.message,
      done: false,
    };
  }
}

export default function ReportListing({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { listingId, title, csrfToken } = loaderData;

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">投稿を通報する</h1>
      <p className="mt-2 text-washi-700">{title}</p>

      <ErrorSummary message={actionData?.message} fields={actionData?.fields} />

      <Form method="post" className="mt-4">
        <CsrfInput token={csrfToken} />

        <RadioGroupField
          name="reason"
          label="通報の理由"
          required
          error={actionData?.fields?.reason}
          options={REPORT_REASONS.map((reason) => ({
            value: reason,
            label: REPORT_REASON_LABEL[reason],
          }))}
        />

        <TextAreaField
          name="detail"
          label="詳しい状況"
          rows={5}
          maxLength={1000}
          error={actionData?.fields?.detail}
          hint="どこが問題かを具体的にお書きください。個人情報は書かないでください。"
        />

        <p className="mt-4 text-sm text-washi-600">
          通報の内容は運営者が確認します。対応の結果を個別にお伝えできない
          場合があります。虚偽の通報は利用停止の対象になります。
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <button type="submit" className="btn btn-primary">
            通報する
          </button>
          <Link to={`/listings/${listingId}`} className="btn btn-secondary">
            やめる
          </Link>
        </div>
      </Form>
    </div>
  );
}
