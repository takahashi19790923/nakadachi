import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/**
 * 統合テストの土台。
 *
 * ★SQLite で代用しない。★ enum・部分一意索引・生成列・GIN 索引・CHECK 制約が
 * どれも検証できず、「テストは通ったが本番で動かない」をそのまま作る。
 *
 * PGlite（PostgreSQL 17 の WASM ビルド）をワイヤプロトコル越しに立てて、
 * 本物のマイグレーションを流す。Docker も Neon も要らない。
 *
 * ★ハマりどころ2つ★
 *  1. spawnSync を使わない。PGlite のソケットサーバーは同じイベントループに
 *     いるので、同期実行すると接続を受け付けられず
 *     「サーバーは動いているのに繋がらない」形で失敗する。
 *  2. maxConnections を明示する。既定は 1 で、2本目の接続が即座に閉じられ、
 *     アプリ側には「Server has closed the connection」としか見えない。
 */

const PORT = Number(process.env.TEST_PG_PORT ?? 5433);

let db: PGlite | null = null;
let server: PGLiteSocketServer | null = null;

export async function setup(): Promise<void> {
  // 実 PostgreSQL を指定されていればそちらを使う（CI で切り替えられる）。
  if (process.env.TEST_DATABASE_URL) {
    console.log("TEST_DATABASE_URL が設定されているため、PGlite は起動しません。");
    await runMigrations(process.env.TEST_DATABASE_URL);
    return;
  }

  db = new PGlite({
    // pg_trgm を積んでおく。0000_extensions.sql の CREATE EXTENSION が通る。
    extensions: { pg_trgm },
  });
  await db.waitReady;

  server = new PGLiteSocketServer({
    db,
    port: PORT,
    host: "127.0.0.1",
    // ★既定の 1 のままだと2本目の接続で落ちる。★
    maxConnections: 20,
  });
  await server.start();

  const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
  process.env.TEST_DATABASE_URL = url;

  await runMigrations(url);
}

export async function teardown(): Promise<void> {
  await server?.stop();
  await db?.close();
  server = null;
  db = null;
}

async function runMigrations(url: string): Promise<void> {
  // ★max: 1。★ 直列に流すので1本で足りる。
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./app/db/migrations" });
  } finally {
    await pool.end();
  }
}
