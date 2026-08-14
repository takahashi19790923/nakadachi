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
export async function handleHealthCheck(options: {
  env: AppEnv;
  getDb: () => Db;
  logger: Logger;
}): Promise<Response> {
  const started = Date.now();
  let dbOk: boolean;
  try {
    const result = await options.getDb().execute<{ ok: number }>(
      sql`select 1 as ok`,
    );
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
