import "dotenv/config";

import { nullLogger } from "../app/server/logger.server.ts";
import { purgeExpiredRateLimits } from "../app/server/rate-limit.server.ts";
import { purgeExpiredSessions } from "../app/server/session.server.ts";
import { purgeExpiredTokens } from "../app/server/services/auth-service.server.ts";
import { purgeDueAccounts } from "../app/server/services/erasure-service.server.ts";
import { expireDueListings } from "../app/server/services/listing-service.server.ts";
import { notifyExpiringListings } from "../app/server/services/notification-service.server.ts";
import type { AppEnv } from "../app/server/env.server.ts";
import {
  confirmIfProduction,
  createScriptDb,
  describeTarget,
  parseTarget,
  requireConnectionString,
} from "./db.ts";

/**
 * 定期処理。
 *
 *   node --experimental-strip-types scripts/cron.ts <task> [dev|preview|production]
 *
 * 接続先は第2引数。省略すると dev。本番は確認を求める（--yes で省略可）。
 *
 * task:
 *   expire-listings   掲載期限を過ぎた投稿を expired にする
 *   notify-expiring   期限が近い投稿の投稿者へ通知する
 *   purge-accounts    ★30日を過ぎた退会依頼を実際に実行する★
 *   purge-media       猶予を過ぎた画像を R2 から消す（Workers 側で実行）
 *   cleanup           期限切れのセッション・トークン・レート制限を掃除する
 *   all               purge-media 以外をすべて
 *
 * ★purge-accounts をテストで実際に動かすこと。★「対象なし」を返す
 * スタブを通していると、本番で初めて実行される日まで一度も走らない。
 *
 * 運用は OPERATIONS.md「定期処理」を参照。GitHub Actions の
 * スケジュール実行、または別 Worker の Cron Trigger から呼ぶ。
 */

/** Node 側から呼ぶ最小限の env。Workers の binding は使わない処理だけを扱う */
function scriptEnv(databaseUrl: string): AppEnv {
  return {
    // R2 binding は Node からは触れない。purge-media は Workers 側で行う。
    MEDIA: undefined as unknown as R2Bucket,
    ENVIRONMENT: (process.env.ENVIRONMENT ?? "development") as AppEnv["ENVIRONMENT"],
    APP_ORIGIN: process.env.APP_ORIGIN ?? "http://localhost:5273",
    SESSION_COOKIE_NAME: "nakadachi_session",
    MAIL_FROM: process.env.MAIL_FROM ?? "なかだち <notice@rewrite-co.com>",
    EMAIL_REPLY_TO: process.env.EMAIL_REPLY_TO ?? "support@rewrite-co.com",
    EXPECTED_CURRENCY: "jpy",
    TURNSTILE_SITE_KEY: "",
    TURNSTILE_EXPECTED_HOSTS: "",
    ADMIN_NOTIFY_EMAIL: process.env.ADMIN_NOTIFY_EMAIL ?? "",
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: process.env.SESSION_SECRET,
    EMAIL_ENCRYPTION_KEY: process.env.EMAIL_ENCRYPTION_KEY,
    EMAIL_INDEX_KEY: process.env.EMAIL_INDEX_KEY,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
  };
}

async function main(): Promise<void> {
  const task = process.argv[2] ?? "all";
  const target = parseTarget(process.argv[3]);
  const url = requireConnectionString(target);
  await confirmIfProduction(target, `定期処理 ${task}`);
  console.log(`定期処理 ${task} → ${describeTarget(target)}`);

  const { db, pool } = createScriptDb(url);
  const env = scriptEnv(url);
  const logger = nullLogger;

  try {
    if (task === "expire-listings" || task === "all") {
      const expired = await expireDueListings(db);
      console.log(`掲載期限切れ: ${expired.length}件`);
    }

    if (task === "notify-expiring" || task === "all") {
      const sent = await notifyExpiringListings({ db, env, logger });
      console.log(`期限予告メール: ${sent}件`);
    }

    if (task === "purge-accounts" || task === "all") {
      const result = await purgeDueAccounts({ db, env, logger });
      console.log(`退会の実行: 成功 ${result.purged}件 / 失敗 ${result.failed}件`);
      // ★失敗を黙って流さない。★ 消えていないのに「消えたつもり」が最悪。
      if (result.failed > 0) process.exitCode = 1;
    }

    if (task === "cleanup" || task === "all") {
      const sessions = await purgeExpiredSessions(db);
      const tokens = await purgeExpiredTokens(db);
      const limits = await purgeExpiredRateLimits(db);
      console.log(
        `掃除: セッション ${sessions} / トークン ${tokens} / レート制限 ${limits}`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    "定期処理に失敗しました:",
    error instanceof Error ? error.message.slice(0, 300) : String(error),
  );
  process.exitCode = 1;
});
