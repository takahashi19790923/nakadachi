import { neonConfig, Pool as NeonPool } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";

import { asDb, type Db } from "~/db/db-type.ts";
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
  let pool: NeonPool | pg.Pool | null = null;
  let db: Db | null = null;

  return {
    getDb() {
      if (db) return db;
      if (env.HYPERDRIVE) {
        /*
         * ★Hyperdrive 経由。★ Cloudflare が DB の近くで接続を張りっぱなしにして
         * 使い回すので、リクエストごとに新しい TCP/TLS を張らない。
         * ドライバは node-postgres（Cloudflare の案内どおり。nodejs_compat が要る）。
         * Pool 自体はリクエストごとに作る（Workers の I/O 共有禁止は変わらない）。
         * max: 1 — 1リクエストの中は直列で足りる。増やしても Hyperdrive 側の
         * 接続を食うだけ。
         *
         * 経緯: 2026-08-17 夜、Cloudflare（NRT）→ Neon（シンガポール）への
         * 直接接続が 2〜40秒に振れる時間帯が2時間以上続いた。HTTP でも
         * WebSocket でも同じで、手元や Vercel からは正常。経路の問題は
         * アプリからは直せないので、接続の張り方そのものを変えた。
         */
        const pgPool = new pg.Pool({
          connectionString: env.HYPERDRIVE.connectionString,
          max: 1,
        });
        pool = pgPool;
        db = asDb(drizzlePg(pgPool, { schema, casing: "snake_case" }));
        return db;
      }
      const connectionString = requireSecret(env, "DATABASE_URL");
      const neonPool = new NeonPool({ connectionString });
      pool = neonPool;
      db = drizzleNeon(neonPool, { schema, casing: "snake_case" });
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
