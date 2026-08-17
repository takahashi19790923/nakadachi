import { eq } from "drizzle-orm";

import { emailDeliveryLogs } from "~/db/schema/index.ts";
import { ulid } from "~/domain/ulid.ts";
import { emailIndexHmac } from "../../crypto.server.ts";
import type { Db } from "../../db.server.ts";
import { hasSecret, isProduction, requireSecret, type AppEnv } from "../../env.server.ts";
import { maskEmail, type Logger } from "../../logger.server.ts";
import type { EmailContent } from "./templates.server.ts";

/**
 * メール送信。
 *
 * 方針
 *  - ★送信の失敗で本処理を巻き戻さない。★ とくに決済確定後の掲載完了メールは、
 *    送れなくても公開は取り消さない。記録を残して再送できるようにする。
 *  - ★冪等キーで二重送信を防ぐ。★ Webhook の再送や画面の連打で同じメールが
 *    何通も届くのを止める。
 *  - ★APIキーとメール本文全体をログに残さない。★ 宛先はマスクした形だけ。
 *
 * Resend の公式 SDK を使わず HTTP API を直接叩いているのは、Workers での
 * 依存を減らすため。使うのは POST /emails の1つだけ。
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type EmailTemplateName =
  | "login_code"
  | "listing_published"
  | "payment_failed"
  | "new_message"
  | "listing_expiring"
  | "listing_suspended"
  | "account_deletion"
  /**
   * ★運営者への警報。利用者へは送らない。★
   * 決済は成立したのに掲載が出ていない、返金したのに掲載が続いている、
   * といった「どちらの画面にもエラーが出ない壊れ方」を知らせる。
   */
  | "ops_payment_alert"
  /** お問い合わせフォームの内容を運営者へ転送する。利用者へは送らない */
  | "contact_inbound";

export interface SendEmailOptions {
  template: EmailTemplateName;
  /** 平文のメールアドレス。★この値をログへ出さないこと★ */
  to: string;
  content: EmailContent;
  /**
   * 同じ出来事に対して同じ値を渡す。
   * 例: `listing_published:<listingId>` / `login_code:<tokenId>`
   */
  idempotencyKey: string;
  userId?: string;
  listingId?: string;
  /**
   * 返信先を差し替えたいとき（お問い合わせの転送で、運営者がそのまま
   * 「返信」を押せば相手に届くようにする）。既定は EMAIL_REPLY_TO。
   */
  replyTo?: string;
}

export interface SendEmailResult {
  readonly sent: boolean;
  readonly skipped: "duplicate" | "not_configured" | null;
}

export async function sendEmail(
  options: SendEmailOptions,
  deps: { db: Db; env: AppEnv; logger: Logger },
): Promise<SendEmailResult> {
  const { db, env, logger } = deps;

  /*
   * ★本番では鍵が無ければ黙って飛ばさない。★ 鍵の投入漏れでログインコードが
   * 1通も届かない状態が「送信済み（skipped）」として静かに続くのを防ぐ。
   * requireSecret は ConfigurationError（503）を投げるので、監視の
   * /api/config と画面の両方で表面化する。記録を作る前に見る（queued の
   * 行を残さない）。ローカルと preview は下の分岐で「送らずに記録だけ」。
   */
  if (isProduction(env)) requireSecret(env, "RESEND_API_KEY");

  const recipientHmac = await emailIndexHmac(
    requireSecret(env, "EMAIL_INDEX_KEY"),
    options.to,
  );

  // ★先に記録を作る。★ 一意制約で弾かれれば「すでに送った」と分かる。
  // 送ってから記録すると、送信成功・記録失敗の隙間で二重送信になる。
  const logId = ulid();
  const inserted = await db
    .insert(emailDeliveryLogs)
    .values({
      id: logId,
      template: options.template,
      recipientHmac,
      userId: options.userId ?? null,
      listingId: options.listingId ?? null,
      idempotencyKey: options.idempotencyKey,
      status: "queued",
    })
    .onConflictDoNothing({ target: emailDeliveryLogs.idempotencyKey });

  if ((inserted.rowCount ?? 0) === 0) {
    logger.info("email skipped: already sent", {
      template: options.template,
      idempotencyKey: options.idempotencyKey,
    });
    return { sent: false, skipped: "duplicate" };
  }

  // ローカル開発では鍵を入れずに動かせるようにする。実際には送らず、
  // 宛先をマスクしたログだけを残す（本文は出さない）。本番は上で弾いてある。
  if (!hasSecret(env, "RESEND_API_KEY")) {
    logger.warn("email not sent: RESEND_API_KEY is not configured", {
      template: options.template,
      recipient: maskEmail(options.to),
      subject: options.content.subject,
    });
    await db
      .update(emailDeliveryLogs)
      .set({ status: "failed", errorCode: "not_configured", updatedAt: new Date() })
      .where(eq(emailDeliveryLogs.id, logId));
    return { sent: false, skipped: "not_configured" };
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${requireSecret(env, "RESEND_API_KEY")}`,
        "content-type": "application/json",
        // Resend 側でも二重送信を止める。こちらの記録と二重化しておく。
        "idempotency-key": options.idempotencyKey.slice(0, 256),
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [options.to],
        reply_to: options.replyTo ?? env.EMAIL_REPLY_TO,
        subject: options.content.subject,
        html: options.content.html,
        text: options.content.text,
      }),
    });

    // ★応答本文を必ず読み切る。★ 読まずに return すると接続が開いたままになり、
    // 同時接続を食い潰していく。curl では絶対に再現しない。
    const payload = (await response.json().catch(() => null)) as {
      id?: string;
      name?: string;
    } | null;

    if (!response.ok) {
      await db
        .update(emailDeliveryLogs)
        .set({
          status: "failed",
          // 事業者の生メッセージではなく短い種別だけを残す。
          errorCode: (payload?.name ?? `http_${response.status}`).slice(0, 80),
          attemptCount: 1,
          updatedAt: new Date(),
        })
        .where(eq(emailDeliveryLogs.id, logId));

      logger.error("email send failed", undefined, {
        template: options.template,
        status: response.status,
        errorCode: payload?.name ?? null,
      });
      return { sent: false, skipped: null };
    }

    await db
      .update(emailDeliveryLogs)
      .set({
        status: "sent",
        providerMessageId: payload?.id ?? null,
        sentAt: new Date(),
        attemptCount: 1,
        updatedAt: new Date(),
      })
      .where(eq(emailDeliveryLogs.id, logId));

    logger.info("email sent", { template: options.template });
    return { sent: true, skipped: null };
  } catch (error) {
    await db
      .update(emailDeliveryLogs)
      .set({
        status: "failed",
        errorCode: "network_error",
        attemptCount: 1,
        updatedAt: new Date(),
      })
      .where(eq(emailDeliveryLogs.id, logId));
    logger.error("email send threw", error, { template: options.template });
    return { sent: false, skipped: null };
  }
}

/**
 * 送信に失敗した記録を拾う。管理画面からの再送に使う。
 * 冪等キーが残っているので、同じキーで送り直すと弾かれる。再送するときは
 * キーに試行回数を足すこと（例: `listing_published:<id>:retry2`）。
 */
export async function listFailedEmails(db: Db, limit = 100) {
  return db
    .select({
      id: emailDeliveryLogs.id,
      template: emailDeliveryLogs.template,
      status: emailDeliveryLogs.status,
      errorCode: emailDeliveryLogs.errorCode,
      createdAt: emailDeliveryLogs.createdAt,
      listingId: emailDeliveryLogs.listingId,
    })
    .from(emailDeliveryLogs)
    .where(eq(emailDeliveryLogs.status, "failed"))
    .limit(limit);
}
