import type { Db } from "./db.server.ts";
import type { AppEnv } from "./env.server.ts";
import type { Logger } from "./logger.server.ts";
import { purgeExpiredRateLimits } from "./rate-limit.server.ts";
import { purgeExpiredSessions } from "./session.server.ts";
import { purgeExpiredAccessRecords } from "./services/access-record-service.server.ts";
import { purgeExpiredTokens } from "./services/auth-service.server.ts";
import { purgeDueAccounts } from "./services/erasure-service.server.ts";
import { expireDueListings } from "./services/listing-service.server.ts";
import { purgeDeletedImages } from "./services/media/media-service.server.ts";
import {
  exportDatabase,
  pruneOldBackups,
} from "./services/backup-service.server.ts";
import { notifyExpiringListings } from "./services/notification-service.server.ts";
import { reconcilePayments } from "./services/payment/reconcile-service.server.ts";
import {
  markEndedListingImages,
  purgeEndedListings,
  purgeOldEmailLogs,
  purgeOldPayments,
  purgeOldWebhookEvents,
  purgeResolvedReports,
} from "./services/retention-service.server.ts";

/**
 * 定期処理。
 *
 * ★Workers の Cron Trigger から呼ぶ。★ 以前は Node のスクリプト
 * （scripts/cron.ts）に書いてあったが、あれは `~/` 別名を使うモジュールを
 * 読めず ERR_MODULE_NOT_FOUND で起動すらしなかった。しかも起動する設定も
 * どこにも無かったので、★退会の30日後の削除も、発信者情報の183日での削除も、
 * 1度も走っていなかった。★（2026-08-16 に発覚）
 *
 * Workers 側に置くと3つ良いことがある。
 *  1. `~/` 別名がビルドで解決されるので、そのまま動く
 *  2. R2 の binding があるので、画像の物理削除もできる（Node からは不可能）
 *  3. 秘密情報が Worker のものをそのまま使える。CI に鍵を置かなくていい
 *
 * ★1つが落ちても残りを必ず動かす。★ まとめて try で囲むと、退会削除が
 * 落ちた日は発信者情報の削除も飛ぶ。約束した削除が静かに滞る。
 */

/** 実行した処理と件数。ログと戻り値に使う */
export type CronResult = Record<string, number | string>;

/** どの cron 式でどれを動かすか */
export const CRON_HOURLY = "0 * * * *";
/** 日次。UTC 19:20 = JST 04:20（利用の少ない時間帯に寄せる） */
export const CRON_DAILY = "20 19 * * *";
/*
 * バックアップは★毎日★取る（2026-08-18〜）。
 *
 * 以前は週1回（UTC 月曜）だった。本番を Neon から Supabase（東京・Free）へ
 * 移したことで、★DB 側の時点復旧（PITR）が無くなった★（Neon Free は6時間あった）。
 * 自前の書き出しが唯一の備えになるので、間隔を1日に詰め、世代を14に増やす。
 * 1回 100KB 程度なので R2 の費用は無視できる。
 *
 * ★曜日つきの cron トリガーは使わない★（Cloudflare の曜日指定は `0` が拒否され、
 * `1`/`7` は発火しなかった。2026-08-17 実測）。日次トリガーの中で毎回走らせる。
 */

interface TaskContext {
  db: Db;
  env: AppEnv;
  logger: Logger;
}

/** 1つの処理を走らせる。落ちても他を止めない */
async function runTask(
  name: string,
  logger: Logger,
  result: CronResult,
  task: () => Promise<number>,
): Promise<void> {
  try {
    result[name] = await task();
  } catch (error) {
    // ★件数ではなく失敗として残す。★ 0件と区別がつかないと、
    // 「毎日動いているが毎回落ちている」に気づけない。
    result[name] = "failed";
    logger.error(`cron task failed: ${name}`, error);
  }
}

/** 1時間ごと。掲載期限の反映と、決済の突き合わせ */
async function runHourly(context: TaskContext): Promise<CronResult> {
  const { db, env, logger } = context;
  const result: CronResult = {};

  await runTask("expireListings", logger, result, async () => {
    const expired = await expireDueListings(db);
    return expired.length;
  });

  /*
   * ★決済と掲載の食い違いを毎時見る。★ 日次にすると、110円払った人が
   * 最大24時間ものあいだ「払ったのに出ない」まま放置される。
   * 問い合わせが来るまで誰も気づけない類なので、間隔を詰める。
   * 中身は2本のクエリで、警報は1件につき1回だけ送る。
   */
  await runTask("reconcilePayments", logger, result, () =>
    reconcilePayments({ db, env, logger }),
  );

  return result;
}

/** 1日1回。バックアップ、削除、通知 */
async function runDaily(
  context: TaskContext,
  now: Date,
): Promise<CronResult> {
  const { db, env, logger } = context;
  const result: CronResult = {};
  void now; // 曜日で分岐していた名残。テストから時刻を渡せる口として残す。

  /*
   * ★バックアップを先に取る。★ このあとに続くのは全部「消す」処理で、
   * 消したあとに書き出すと、その日のバックアップからは消したものが
   * 失われている。取り戻したいのは消える前の状態のほう。
   */
  await runBackup(context, result);

  // ★約束した削除を先に置く。★ 実行時間の上限に当たった場合でも、
  // 「30日で消します」「183日で消します」と書いたものが優先して走る。
  await runTask("purgeAccounts", logger, result, async () => {
    const { purged, failed } = await purgeDueAccounts({ db, env, logger });
    if (failed > 0) logger.error("account purge had failures", new Error(`failed=${failed}`));
    return purged;
  });

  await runTask("purgeAccessRecords", logger, result, () =>
    purgeExpiredAccessRecords(db),
  );

  /*
   * ここから保持期間の掃除。★順番が命。★
   *
   * 掲載を消すと listing_images は連鎖削除されるが、R2 のオブジェクトは
   * 消えない。行だけ消えて実体が残ると、どこからも参照されない課金対象が
   * 永久に残り、誰も気づけない。
   *
   *   ① 終わって90日の掲載の写真に削除待ちの印をつける
   *   ② 削除待ちの写真を R2 から消す（退会ぶんもここで消える）
   *   ③ 写真が1枚も残っていない掲載だけを消す（180日）
   *
   * ③に「写真が残っていないこと」を条件として入れてあるので、
   * ①②が落ちた日は③も自動的に見送られる。
   */
  await runTask("markEndedImages", logger, result, () =>
    markEndedListingImages(db),
  );

  await runTask("purgeDeletedImages", logger, result, () =>
    purgeDeletedImages({ db, env, logger }),
  );

  await runTask("purgeEndedListings", logger, result, () =>
    purgeEndedListings(db),
  );

  await runTask("purgeWebhookEvents", logger, result, () =>
    purgeOldWebhookEvents(db),
  );
  await runTask("purgeEmailLogs", logger, result, () => purgeOldEmailLogs(db));
  await runTask("purgeResolvedReports", logger, result, () =>
    purgeResolvedReports(db),
  );
  // 帳簿として7年。ここを短くしない。
  await runTask("purgeOldPayments", logger, result, () => purgeOldPayments(db));

  await runTask("notifyExpiring", logger, result, () =>
    notifyExpiringListings({ db, env, logger }),
  );

  await runTask("purgeSessions", logger, result, () => purgeExpiredSessions(db));
  await runTask("purgeTokens", logger, result, () => purgeExpiredTokens(db));
  await runTask("purgeRateLimits", logger, result, () =>
    purgeExpiredRateLimits(db),
  );

  return result;
}

/**
 * 毎日、DB を R2 へ書き出す。日次の中から呼ぶ。
 *
 * ★DB 側の時点復旧に頼らない。★ Supabase Free にはバックアップも PITR も無い
 * （Neon Free でも6時間だけだった）。これが唯一の備え。課金が始まると、
 * 失うものがテストデータではなく利用者の投稿と決済記録になる。
 */
async function runBackup(
  context: TaskContext,
  result: CronResult,
): Promise<void> {
  const { db, env, logger } = context;

  await runTask("exportDatabase", logger, result, async () => {
    const exported = await exportDatabase({ db, env, logger });
    return exported.bytes;
  });

  // ★書き出しが失敗した週は古い世代を消さない。★ 消してから失敗すると
  // 手元に何も残らない回ができる。runTask は失敗を "failed" で返す。
  if (result.exportDatabase !== "failed") {
    await runTask("pruneBackups", logger, result, () =>
      pruneOldBackups({ env, logger }),
    );
  }
}

/**
 * Cron Trigger の入口。
 *
 * 知らない cron 式が来たら日次を走らせる。式を足したときに
 * 「何も動かない」より「多めに動く」ほうが安全（どれも冪等）。
 */
export async function runScheduledTasks(options: {
  cron: string;
  db: Db;
  env: AppEnv;
  logger: Logger;
  /** テストから曜日を指定するため。既定は現在時刻 */
  now?: Date;
}): Promise<CronResult> {
  const { cron, db, env, logger } = options;
  const context: TaskContext = { db, env, logger };
  const now = options.now ?? new Date();

  const result =
    cron === CRON_HOURLY
      ? await runHourly(context)
      : await runDaily(context, now);

  logger.info("cron finished", { cron, ...result });
  return result;
}
