import { sql } from "drizzle-orm";

import type { Db } from "../../db.server.ts";
import type { AppEnv } from "../../env.server.ts";
import type { Logger } from "../../logger.server.ts";
import { sendEmail } from "../email/email-service.server.ts";
import { opsPaymentAlertEmail } from "../email/templates.server.ts";

/**
 * 決済と掲載の突き合わせ。
 *
 * ★いちばん怖い壊れ方は「決済が成功しているのに掲載が出ない」。★
 * Stripe 側は入金成功で終わり、こちらも Webhook に 200 を返して終わる。
 * ★どちらの画面にもエラーが出ない。★ 利用者は110円払ったまま黙って去る。
 *
 * 実際に3種類の原因でこれを作った（2026-08-16）。
 *  - 状態遷移の戻り値を見ておらず、公開できなくても素通りしていた
 *  - 失効通知が新しい決済を追い越して投稿を下書きへ戻していた
 *  - 返金が先に確定したあとで支払い成立が届くと公開されうる
 *
 * 直したうえで、それでも起きたときに★人が気づける経路★を作る。
 * 管理画面にも件数を出しているが、あれは見に行かないと分からない。
 *
 * 警報は1件につき1回だけ送る。メール送信の冪等キーで抑えているので、
 * 同じ決済で毎時鳴り続けることはない。
 */

/** 決済成立からこれだけ経っても公開されていなければ異常とみなす */
const GRACE_MINUTES = 60;

export interface PaymentAnomaly {
  readonly kind: "paid_not_published" | "refunded_but_live";
  readonly paymentId: string;
  readonly listingId: string;
  readonly listingTitle: string;
  readonly listingStatus: string;
}

/**
 * 取り残しと剥がし漏れを探す。
 *
 * ★「公開されたことがあるか」は published_at で見る。★ status では判定できない。
 * 公開後に本人が掲載終了した投稿は closed になるが、それは正常な状態で、
 * status だけを見ると取り残しと区別がつかない。
 */
export async function findPaymentAnomalies(db: Db): Promise<PaymentAnomaly[]> {
  const rows = await db.execute<{
    kind: string;
    payment_id: string;
    listing_id: string;
    title: string;
    status: string;
  }>(sql`
    select 'paid_not_published' as kind,
           p.id as payment_id, l.id as listing_id, l.title, l.status
    from payments p
    join listings l on l.id = p.listing_id
    where p.status = 'succeeded'
      and p.paid_at <= now() - make_interval(mins => ${GRACE_MINUTES})
      and l.published_at is null

    union all

    select 'refunded_but_live' as kind,
           p.id as payment_id, l.id as listing_id, l.title, l.status
    from payments p
    join listings l on l.id = p.listing_id
    where p.status = 'refunded'
      and l.status = 'published'
  `);

  return rows.rows.map((row) => ({
    kind: row.kind as PaymentAnomaly["kind"],
    paymentId: row.payment_id,
    listingId: row.listing_id,
    listingTitle: row.title,
    listingStatus: row.status,
  }));
}

/**
 * 処理に失敗した Webhook の件数。
 *
 * ★失敗しても Stripe には 200 を返している。★ 同じ入力なら再送しても
 * 同じ失敗になるという判断でそうしてあるが、代わりに誰かが気づく必要がある。
 *
 * ★受け取ったまま止まっているものも数える。★ 重複防止の行を先に作ってから
 * 処理する作りなので、処理の途中で Worker が落ちると status='received' の
 * まま残る。Stripe の再送は一意制約に当たって「重複」で素通りし、
 * 誰も処理しない。failed だけを見ていると、この形の「払ったのに出ない」が
 * どの警報にも掛からなかった（2026-08-17 の点検で発覚）。
 * 15分は「処理中」の可能性を見て猶予にしている。
 */
export async function countFailedWebhooks(db: Db): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
    from payment_webhook_events
    where status = 'failed'
       or (status = 'received' and received_at < now() - interval '15 minutes')
  `);
  return rows.rows[0]?.n ?? 0;
}

/**
 * 突き合わせて、異常があれば運営者へ知らせる。
 *
 * 戻り値は見つかった件数（投稿単位の異常 ＋ 処理できていない Webhook）。0 なら健全。
 */
export async function reconcilePayments(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
}): Promise<number> {
  const { db, env, logger } = options;

  const [anomalies, failedWebhooks] = await Promise.all([
    findPaymentAnomalies(db),
    countFailedWebhooks(db),
  ]);

  if (anomalies.length === 0 && failedWebhooks === 0) return 0;

  /*
   * ★ログには必ず残す。★ メールが送れなくても記録は残る。
   * 決済まわりの異常は、届かなかったで終わらせない。
   */
  logger.error(
    "payment reconciliation found anomalies",
    new Error(`anomalies=${anomalies.length} failedWebhooks=${failedWebhooks}`),
    {
      paidNotPublished: anomalies.filter((a) => a.kind === "paid_not_published")
        .length,
      refundedButLive: anomalies.filter((a) => a.kind === "refunded_but_live")
        .length,
      failedWebhooks,
    },
  );

  const to = env.EMAIL_REPLY_TO;

  /*
   * ★失敗した Webhook についてもメールを出す。★ 以前は件数をログに出す
   * だけで、メールは投稿単位の異常にしか出していなかった。Session を作った
   * 直後に決済記録の INSERT が失敗した場合などは、投稿側に痕跡が無いので
   * こちらにしか出ない。1日に1通（件数が変わっても同じ日は再送しない。
   * 直すまで毎時鳴らさないのは上と同じ理由）。
   */
  if (failedWebhooks > 0) {
    const day = new Date().toISOString().slice(0, 10);
    await sendEmail(
      {
        template: "ops_payment_alert",
        to,
        content: opsPaymentAlertEmail({
          kind: "failed_webhooks",
          listingTitle: `処理できていない決済通知が ${failedWebhooks} 件`,
          listingStatus: "payment_webhook_events.status = failed / received（15分超）",
          adminUrl: new URL("/admin/payments", env.APP_ORIGIN).toString(),
        }),
        idempotencyKey: `ops_payment_alert:failed_webhooks:${day}`,
      },
      { db, env, logger },
    ).catch((error: unknown) => {
      logger.error("ops alert email failed", error, { kind: "failed_webhooks" });
    });
  }

  for (const anomaly of anomalies) {
    /*
     * ★1件につき1回だけ。★ 冪等キーで抑える。直すまで毎時鳴ると
     * 慣れて読まなくなり、本当に見るべき日に見落とす。
     */
    await sendEmail(
      {
        template: "ops_payment_alert",
        to,
        content: opsPaymentAlertEmail({
          kind: anomaly.kind,
          listingTitle: anomaly.listingTitle,
          listingStatus: anomaly.listingStatus,
          adminUrl: new URL("/admin/payments", env.APP_ORIGIN).toString(),
        }),
        idempotencyKey: `ops_payment_alert:${anomaly.kind}:${anomaly.paymentId}`,
        listingId: anomaly.listingId,
      },
      { db, env, logger },
    ).catch((error: unknown) => {
      // 送れなくても他の件と定期処理を止めない。上のログには残っている。
      logger.error("ops alert email failed", error, {
        paymentId: anomaly.paymentId,
      });
    });
  }

  // 失敗した Webhook も「異常」として数える。0 が返るのは健全なときだけ。
  return anomalies.length + failedWebhooks;
}
