import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";

import type { Db } from "~/db/db-type.ts";
import * as schema from "~/db/schema/index.ts";
import { requireSecret, type AppEnv } from "./env.server.ts";

// 型と asDb は app/db/db-type.ts にある。素の Node から読めるようにするため
// （理由はそのファイルの説明を参照）。ここからは今までどおり再輸出する。
export { asDb, type Db, type DbSchema } from "~/db/db-type.ts";

/**
 * 単発の問い合わせは WebSocket ではなく HTTP で投げる。
 *
 * 公開ページは読み取りしかしないので、リクエストのたびに WebSocket を
 * 張ると往復が丸ごと無駄になる。トランザクション（pool.connect）のときだけ
 * WebSocket が開く。設定はモジュール読み込み時に1回でよい（接続そのものを
 * 共有しているわけではないので、リクエスト跨ぎの問題は起きない）。
 */
neonConfig.poolQueryViaFetch = true;

/**
 * ★DB クライアントはリクエストごとに作る。★
 *
 * Cloudflare Workers は I/O オブジェクトをリクエスト間で共有することを
 * 禁止している。モジュール変数や globalThis にキャッシュすると、
 * 2回目以降のリクエストで
 *   "Cannot perform I/O on behalf of a different request"
 * が出て 500 になる。同じ isolate に当たったリクエストだけが落ちるので
 * 「10回中2回だけ 500」のような分かりにくい出方をする。
 * ★ローカル（miniflare）では一度も再現しない。デプロイして初めて出る。★
 *
 * 生成は遅延させている。静的アセットや DB を触らない画面で、接続だけ作って
 * 捨てる無駄を避けるため。
 */
export function createRequestDb(env: AppEnv): {
  getDb: () => Db;
  dispose: () => Promise<void>;
} {
  let pool: Pool | null = null;
  let db: Db | null = null;

  return {
    getDb() {
      if (db) return db;
      const connectionString = requireSecret(env, "DATABASE_URL");
      pool = new Pool({ connectionString });
      db = drizzle(pool, { schema, casing: "snake_case" });
      return db;
    },
    async dispose() {
      if (!pool) return;
      try {
        await pool.end();
      } catch {
        // 後始末の失敗で応答を壊さない。接続はリクエスト終了で回収される。
      }
      pool = null;
      db = null;
    },
  };
}
