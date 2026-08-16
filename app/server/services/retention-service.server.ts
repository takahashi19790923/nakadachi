import { sql } from "drizzle-orm";

import {
  EMAIL_LOG_RETENTION_DAYS,
  ENDED_LISTING_STATUSES,
  IMAGE_RETENTION_DAYS,
  LISTING_RETENTION_DAYS,
  PAYMENT_RETENTION_DAYS,
  REPORT_RETENTION_DAYS,
  WEBHOOK_EVENT_RETENTION_DAYS,
} from "~/domain/retention.ts";
import type { Db } from "../db.server.ts";

/**
 * 保持期間を過ぎたものを消す。
 *
 * ★順番が命。★ 掲載を消すと listing_images は連鎖削除されるが、
 * ★R2 のオブジェクトは消えない。★ 行だけ消えて実体が残ると、
 * どこからも参照されない課金対象が永久に残る。誰も気づけない。
 *
 * 日次の並びは
 *   ① 終わった掲載の写真に削除待ちの印をつける（90日）
 *   ② 削除待ちの写真を R2 から消す（既存の purgeDeletedImages）
 *   ③ 写真が1枚も残っていない掲載だけを消す（180日）
 * の順にする。③に「写真が残っていないこと」を条件として入れてあるので、
 * ①②が落ちた日には③も自動的に見送られる。
 *
 * 「終わった掲載」の時刻は closed_at → deleted_at → updated_at の順で見る。
 * rejected は遷移で専用の時刻を持たないため、updated_at が受け皿になる。
 */

/**
 * 終わった掲載の状態の一覧。`in (...)` の中身だけを作る。
 *
 * ★列名まで含めた断片にしない。★ `l.${片}` のように連結すると、
 * 断片の先頭の空白や改行がそのまま入って `l. status` になる。
 * 目で見て気づきにくく、実行して初めて落ちる。
 */
const endedStatusList = sql.join(
  ENDED_LISTING_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

/**
 * ① 終わって90日を過ぎた掲載の写真に、削除待ちの印をつける。
 *
 * 実体の削除は既存の purgeDeletedImages が行う。ここで印をつけるだけに
 * しているのは、R2 の削除を1か所に集めておくため。
 */
export async function markEndedListingImages(db: Db): Promise<number> {
  const result = await db.execute(sql`
    update listing_images as i
    set deleted_at = now(), purge_after = now()
    from listings as l
    where i.listing_id = l.id
      and l.status in (${endedStatusList})
      and coalesce(l.closed_at, l.deleted_at, l.updated_at)
          <= now() - make_interval(days => ${IMAGE_RETENTION_DAYS})
      and i.purge_after is null
  `);
  return result.rowCount ?? 0;
}

/**
 * ③ 終わって180日を過ぎた掲載を消す。
 *
 * ★写真が1枚でも残っていれば消さない。★ 消すと listing_images が
 * 連鎖削除され、R2 の実体だけが取り残される。
 *
 * 決済記録は `on delete set null` で残る（帳簿として7年保持する）。
 * カテゴリ詳細・お気に入り・会話・通報は連鎖で一緒に消える。
 */
export async function purgeEndedListings(
  db: Db,
  limit = 200,
): Promise<number> {
  const result = await db.execute(sql`
    delete from listings
    where id in (
      select l.id
      from listings as l
      where l.status in (${endedStatusList})
        and coalesce(l.closed_at, l.deleted_at, l.updated_at)
            <= now() - make_interval(days => ${LISTING_RETENTION_DAYS})
        and not exists (
          select 1 from listing_images as i where i.listing_id = l.id
        )
      limit ${limit}
    )
  `);
  return result.rowCount ?? 0;
}

/** 決済 Webhook のイベント記録。本文は持っていない（ダイジェストのみ） */
export async function purgeOldWebhookEvents(db: Db): Promise<number> {
  const result = await db.execute(sql`
    delete from payment_webhook_events
    where created_at <= now() - make_interval(days => ${WEBHOOK_EVENT_RETENTION_DAYS})
  `);
  return result.rowCount ?? 0;
}

/** メール送信ログ。宛先は持っていない（冪等キーと結果のみ） */
export async function purgeOldEmailLogs(db: Db): Promise<number> {
  const result = await db.execute(sql`
    delete from email_delivery_logs
    where created_at <= now() - make_interval(days => ${EMAIL_LOG_RETENTION_DAYS})
  `);
  return result.rowCount ?? 0;
}

/**
 * 対応済みの通報。
 *
 * ★未対応（open）は消さない。★ 期間で消すと、放置された通報が
 * 静かに消えて「対応した」ことになる。
 */
export async function purgeResolvedReports(db: Db): Promise<number> {
  const result = await db.execute(sql`
    delete from reports
    where resolved_at is not null
      and resolved_at <= now() - make_interval(days => ${REPORT_RETENTION_DAYS})
  `);
  return result.rowCount ?? 0;
}

/**
 * 決済記録。
 *
 * ★7年。★ 帳簿書類としての保存義務があるため、他とは寿命が違う。
 * ここを短くしてはいけない。
 */
export async function purgeOldPayments(db: Db): Promise<number> {
  const result = await db.execute(sql`
    delete from payments
    where created_at <= now() - make_interval(days => ${PAYMENT_RETENTION_DAYS})
  `);
  return result.rowCount ?? 0;
}
