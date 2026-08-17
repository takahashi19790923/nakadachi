import { sql } from "drizzle-orm";

import type { Db } from "./db.server.ts";
import type { AppEnv } from "./env.server.ts";
import type { Logger } from "./logger.server.ts";

/**
 * /api/health
 *
 * 認証不要・副作用なし・軽い。★DB まで実際に触る。★
 * HTML の 200 だけを見る監視は、DB が死んでいる状態を「正常」と誤判定する。
 *
 * ★返すのは真偽と所要ミリ秒だけ。★ 利用者数や設定値のような事業情報を
 * 出さない。監視の口は誰でも叩けるという前提で作る。
 */
/**
 * DB の応答をこれ以上待たない。
 *
 * ★上限が無いと、詰まったときに「遅い」ではなく「返ってこない」になる。★
 * 監視側は自分のタイムアウトで切るしかなく、こちらの ms は意味を失う。
 * 2026-08-17 に Neon の応答が 2〜30秒に振れる時間帯があり、上限無しの
 * 状態で 35秒待って接続失敗になった。fail-close で 503 を即座に返す。
 * 平常時の実測は 80〜200ms、アイドル明けの起動で 600〜700ms。
 */
const DB_TIMEOUT_MS = 5_000;

export async function handleHealthCheck(options: {
  env: AppEnv;
  getDb: () => Db;
  logger: Logger;
}): Promise<Response> {
  const started = Date.now();
  let dbOk: boolean;
  try {
    const query = options.getDb().execute<{ ok: number }>(sql`select 1 as ok`);
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`db timeout after ${DB_TIMEOUT_MS}ms`)), DB_TIMEOUT_MS);
    });
    const result = await Promise.race([query, timeout]);
    dbOk = Number(result.rows[0]?.ok) === 1;
  } catch (error) {
    options.logger.error("health check: database unreachable", error);
    dbOk = false;
  }

  const body = JSON.stringify({
    ok: dbOk,
    db: dbOk,
    ms: Date.now() - started,
  });

  return new Response(body, {
    status: dbOk ? 200 : 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
