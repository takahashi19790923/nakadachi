import { Form, Link } from "react-router";

import { CsrfInput, ErrorSummary, TextAreaField } from "~/components/form";
import { StatusBadge } from "~/components/ui";
import { allowedTransitions, InvalidTransitionError } from "~/domain/listing-status";
import { formatDateTimeJa } from "~/domain/listing-view";
import { privatePageMeta } from "~/domain/seo";
import { isUlid } from "~/domain/ulid";
import { writeAdminAction, writeAuditLog } from "~/server/audit.server";
import { readCookie } from "~/server/cookies.server";
import { assertSameOrigin, csrfCookieName, verifyCsrfToken } from "~/server/csrf.server";
import { AppError, notFound, toPublicError } from "~/server/errors";
import { requireAdminGate } from "~/server/guards.server";
import { getListingForOwner } from "~/server/repositories/listing-repository.server";
import { transitionListing } from "~/server/services/listing-service.server";
import { notifyListingSuspended } from "~/server/services/notification-service.server";
import { cancelOpenCheckouts } from "~/server/services/payment/payment-service.server";
import { formString } from "~/domain/validation/common";
import type { Route } from "./+types/admin.listing-detail";
import { getApp } from "~/server/app-context";

export async function loader({ request, context: rawContext, params }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  await requireAdminGate({ request, context });
  if (!isUlid(params.listingId)) throw notFound("malformed id");

  const listing = await getListingForOwner(context.getDb(), params.listingId);
  if (!listing) throw notFound(`listing not found: ${params.listingId}`);

  return { listing, csrfToken: context.csrfToken };
}

export function meta(): Route.MetaDescriptors {
  return privatePageMeta("投稿の対応（管理）");
}

export async function action({ request, context: rawContext, params }: Route.ActionArgs) {
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

    const intent = formString(formData, "intent");
    const reason = formString(formData, "reason").trim();

    // ★理由を必須にする。★ あとから判断の当否を検証できるようにするため。
    if (reason.length < 5) {
      const fields: Record<string, string> = {
        reason: "対応の理由を5文字以上で入力してください",
      };
      return { fields, message: null };
    }

    const target =
      intent === "suspend"
        ? ("suspended" as const)
        : intent === "reject"
          ? ("rejected" as const)
          : intent === "restore"
            ? ("published" as const)
            : intent === "delete"
              ? ("deleted" as const)
              : null;

    /*
     * ★削除だけは «削除» と打たせる。★
     *
     * 削除は終端で、戻す経路が状態遷移表に無い（deleted: {}）。
     * それを、非公開・却下・公開に戻すと同じ «押すだけ» で並べない。
     * 急いでいるときに、隣にあるボタンは押される。
     *
     * ★この操作は状態遷移表がずっと管理者に許していたのに、呼ぶ画面が
     * どこにも無かった。★ 監査ログの種別（listing_delete）まで用意されて
     * いて、配線だけが無い状態だった（2026-08-29 に発見）。
     */
    if (target === "deleted" && formString(formData, "confirm").trim() !== "削除") {
      const fields: Record<string, string> = {
        confirm: "削除する場合は「削除」と入力してください（取り消せません）",
      };
      return { fields, message: null };
    }

    if (!target) {
      throw new AppError("validation_failed", "操作の指定が不正です。", {
        detail: `unknown admin intent: ${intent}`,
      });
    }

    // ★本処理と管理操作の記録を1つのトランザクションにする。★（監査 ADM-03）
    // 記録に失敗したら操作も巻き戻す（«止めたのに記録が無い» を作らない）。
    await db.transaction(async (tx) => {
      await transitionListing(tx, {
        listingId: params.listingId,
        to: target,
        actor: "admin",
        moderationReason: reason,
      });

      await writeAdminAction(tx, {
        adminId: admin.id,
        actionType:
          target === "suspended"
            ? "listing_suspend"
            : target === "rejected"
              ? "listing_reject"
              : target === "deleted"
                ? "listing_delete"
                : "listing_restore",
        targetType: "listing",
        targetId: params.listingId,
        reason,
      });
      await writeAuditLog(tx, context.env, {
        action: `admin.listing_${target}`,
        actorId: admin.id,
        actorRole: "admin",
        targetType: "listing",
        targetId: params.listingId,
        request,
      });
    });

    /*
     * ★却下・削除した投稿の支払いリンクを無効にする。★（監査 ADM-15）
     * 決済待ちの投稿だけが生きたリンクを持つ（公開済みの決済は確定済みで対象外）。
     * 管理者の判断は止めない。払い終わっていたら突き合わせの警報が拾い、
     * 規約第5条2項（お支払いの後・公開の前の却下・削除は全額返金）で返す。
     */
    if (target === "rejected" || target === "deleted") {
      // ★失効に失敗しても、却下・削除の記録と通知は残す。★ 遷移はもう済んでいる。
      try {
        const { paidInProgress } = await cancelOpenCheckouts({
          db,
          env: context.env,
          logger: context.logger,
          listingId: params.listingId,
        });
        if (paidInProgress) {
          context.logger.warn("admin closed a listing whose checkout may be paid", {
            listingId: params.listingId,
            target,
          });
        }
      } catch (error) {
        context.logger.error("failed to cancel open checkouts after admin action", error, {
          listingId: params.listingId,
          target,
        });
      }
    }

    // ★非公開にしても自動返金はしない。★ 返金は決済状況の画面から明示的に行う。
    if (target === "suspended" || target === "rejected") {
      context.defer(
        notifyListingSuspended({
          db,
          env: context.env,
          logger: context.logger,
          listingId: params.listingId,
          reason,
          kind: target,
        }).catch(() => undefined),
      );
    }

    return { fields: null, message: null };
  } catch (error) {
    if (error instanceof Response) throw error;
    /*
     * ★状態の上でできない操作は、そう伝える。★（監査 E-4-1）
     * 以前は «処理中に問題が発生しました» の汎用文言とエラーログに化けていた。
     */
    if (error instanceof InvalidTransitionError) {
      return { fields: null, message: "この投稿の状態では、その操作はできません。" };
    }
    context.logger.error("admin listing action failed", error);
    const publicError = toPublicError(error);
    return { fields: publicError.fields ?? null, message: publicError.message };
  }
}

export default function AdminListingDetail({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { listing, csrfToken } = loaderData;
  const allowed = new Set(allowedTransitions(listing.status, "admin"));

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <p className="text-sm">
        <Link to="/admin/listings" className="link">
          投稿一覧へ戻る
        </Link>
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <StatusBadge status={listing.status} />
        <span className="text-sm text-washi-600">
          {formatDateTimeJa(listing.createdAt)}
        </span>
      </div>

      <h1 className="mt-2 text-xl font-bold text-washi-900">{listing.title}</h1>
      <p className="mt-2 whitespace-pre-wrap break-words text-washi-800">
        {listing.body}
      </p>
      <p className="mt-2 text-sm text-washi-600">
        {listing.prefectureName} {listing.cityName}
      </p>

      {listing.images.length > 0 ? (
        <ul className="mt-4 grid grid-cols-3 gap-2">
          {listing.images.map((image, index) => (
            <li key={image.id}>
              <img
                src={`/media/${encodeURIComponent(image.objectKey)}`}
                alt={`写真 ${index + 1}`}
                width={image.width}
                height={image.height}
                loading="lazy"
                className="aspect-square w-full rounded object-cover"
              />
            </li>
          ))}
        </ul>
      ) : null}

      <ErrorSummary message={actionData?.message} fields={actionData?.fields} />

      <Form method="post" className="mt-8 border-t border-washi-200 pt-6">
        <CsrfInput token={csrfToken} />

        <TextAreaField
          name="reason"
          label="対応の理由"
          required
          rows={3}
          maxLength={500}
          error={actionData?.fields?.reason}
          hint="投稿者への通知にも使われます。監査ログに残ります。"
        />

        {/*
          ★押すと必ず失敗するボタンを出さない。★（監査 FN-15・E-4-1）
          出すのは、遷移表がいまの状態から管理者に許している操作だけ。
        */}
        <div className="mt-4 flex flex-wrap gap-3">
          {allowed.has("suspended") ? (
            <button
              type="submit"
              name="intent"
              value="suspend"
              className="btn btn-danger"
            >
              非公開にする
            </button>
          ) : null}
          {allowed.has("rejected") ? (
            <button
              type="submit"
              name="intent"
              value="reject"
              className="btn btn-danger"
            >
              却下する
            </button>
          ) : null}
          {allowed.has("published") ? (
            <button
              type="submit"
              name="intent"
              value="restore"
              className="btn btn-secondary"
            >
              公開に戻す
            </button>
          ) : null}
          {allowed.size === 0 ? (
            <p className="text-sm text-washi-600">この状態の投稿に、管理者が行える操作はありません。</p>
          ) : null}
        </div>

        {allowed.has("deleted") ? (
        <div className="mt-8 rounded-lg border-2 border-red-300 bg-red-50 p-4">
          <p className="font-bold text-red-900">投稿を削除する（取り消せません）</p>
          <p className="mt-1 text-sm text-red-900">
            写真も一緒に消えます。<strong>元に戻す経路はありません。</strong>
            公開を止めたいだけなら「非公開にする」を使ってください。
          </p>
          <label className="field-label mt-3" htmlFor="confirm">
            確認のため「削除」と入力
          </label>
          <input
            id="confirm"
            type="text"
            name="confirm"
            className="field-input"
            autoComplete="off"
            aria-describedby={actionData?.fields?.confirm ? "confirm-error" : undefined}
          />
          {actionData?.fields?.confirm ? (
            <p id="confirm-error" className="mt-1 text-sm font-semibold text-red-800">
              {actionData.fields.confirm}
            </p>
          ) : null}
          <button
            type="submit"
            name="intent"
            value="delete"
            className="btn btn-danger mt-3"
          >
            削除する
          </button>
        </div>
        ) : null}

        <p className="mt-4 text-sm text-washi-600">
          非公開・却下にしても、掲載料は自動返金されません。返金が必要な場合は
          <Link to="/admin/payments" className="link mx-1">
            決済状況
          </Link>
          から明示的に処理してください（お支払いの後・公開の前に却下・削除した場合は、
          利用規約第5条により全額返金の対象です）。判断の誤りで非公開・却下にした
          公開済みの投稿を «公開に戻す» と、止めていた期間の分だけ掲載期間が延びます。
        </p>
      </Form>
    </div>
  );
}
