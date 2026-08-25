import "dotenv/config";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import {
  createScriptDb,
  describeError,
  requireConnectionString,
} from "./db.ts";
import {
  parseBackup,
  restoreDatabase,
  verifyRestore,
} from "../app/server/services/restore-service.server.ts";

/**
 * 復旧の練習（手元の使い捨て DB）。
 *
 *   pnpm run db:drill ./db-backup/restore.json
 *
 * ★「バックアップがある」と「戻せる」は別。★ 障害の最中にぶっつけでやらない。
 *
 * ここでやること:
 *   1. 手元に空の PostgreSQL を立てる（PGlite。Docker も外部の DB も要らない）
 *   2. マイグレーションで器を作る
 *   3. ★本物の本番の写し★を流し込む
 *   4. 件数を突き合わせる
 *   5. ★戻したあとに書き込めることまで確かめる★（読めるだけでは戻ったと言わない）
 *
 * ★測れないもの：東京への往復時間。★
 * それには Supabase の使い捨てプロジェクトが要るが、無料枠はアカウント
 * あたり2つで、本番2つ（nakadachi / vtuber-sns）で埋まっている
 * （2026-08-26 確認。新しい組織を作っても増えない）。
 * ここで分かるのは「手順が通ること」と「実データ特有の問題が無いこと」。
 *
 * ★写しは個人情報。★ 終わったらプロセスごと消えるが、
 * 元のファイル（db-backup/）は手で消すこと。
 */

const PORT = Number(process.env.DRILL_PG_PORT ?? 5434);

function usage(): never {
  console.error(
    [
      "使い方: pnpm run db:drill <写しのファイル>",
      "",
      "例: pnpm run db:drill ./db-backup/restore.json",
      "",
      "写しは R2 から落とします（OPERATIONS.md「DB を復旧する」）:",
      "  pnpm exec wrangler r2 object get nakadachi-backups/db/YYYY-MM-DD.json \\",
      "    --file ./db-backup/restore.json --remote",
    ].join("\n"),
  );
  process.exit(1);
}

function seconds(from: number): string {
  return `${((Date.now() - from) / 1000).toFixed(1)} 秒`;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) usage();

  // ── 写しを読む（DB を立てる前に確かめる）────────────────────
  const started = Date.now();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`ファイルを読めません: ${describeError(error)}`, {
      cause: error,
    });
  }

  const backup = parseBackup(text);
  const totalRows = backup.tables.reduce((sum, t) => sum + t.rows, 0);
  console.log(`\n■ 写し`);
  console.log(`  ファイル   : ${file}`);
  console.log(`  書き出し   : ${backup.exportedAt}（${backup.environment}）`);
  console.log(`  表 / 行    : ${backup.tables.length} 表 / ${totalRows} 行`);
  console.log(`  大きさ     : ${(text.length / 1024).toFixed(1)} KB`);

  // ── 手元に空の PostgreSQL を立てる ──────────────────────────
  console.log(`\n■ 器を用意する`);
  const t1 = Date.now();
  const pglite = new PGlite({ extensions: { pg_trgm } });
  await pglite.waitReady;
  const server = new PGLiteSocketServer({
    db: pglite,
    port: PORT,
    host: "127.0.0.1",
    // ★既定の 1 のままだと2本目の接続で落ちる。★
    maxConnections: 20,
  });
  await server.start();
  console.log(`  PostgreSQL を起動  ${seconds(t1)}`);

  process.env.DATABASE_URL_DRILL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
  const { db, pool } = createScriptDb(requireConnectionString("drill"));

  let ok = false;
  try {
    // ── マイグレーション ────────────────────────────────────
    const t2 = Date.now();
    await migrate(db, { migrationsFolder: "./app/db/migrations" });
    console.log(`  マイグレーション   ${seconds(t2)}`);

    // ── 流し込み ────────────────────────────────────────────
    console.log(`\n■ 流し込む`);
    const t3 = Date.now();
    const result = await restoreDatabase({ db, backup, replace: true });
    const restoreTime = seconds(t3);

    for (const row of result.tables) {
      if (row.inserted > 0) {
        console.log(`  ${row.table.padEnd(28)} ${row.inserted}`);
      }
    }
    console.log(`  ── 所要 ${restoreTime}`);

    // ── 確かめる ────────────────────────────────────────────
    console.log(`\n■ 確かめる`);
    const problems = await verifyRestore({ db, backup });
    if (problems.length > 0) {
      console.error("  ★件数が合いません★");
      for (const p of problems) console.error(`    ${p}`);
      return;
    }
    console.log(`  件数の一致         ${totalRows} 行すべて一致`);

    /*
     * ★読めるだけで «戻った» と言わない。★ 実際に書き込んでみる。
     * ここが通らないと、復旧の後で利用者が何もできない。
     * 制約・索引・生成列が生きているかは、書いて初めて分かる。
     */
    const probe = `drill-${Date.now()}`;
    await db.execute(sql`
      insert into locations (id, code, kind, name, kana, romaji, sort_order, is_active)
      values (${probe}, ${probe.slice(-8)}, 'prefecture', '練習', 'れんしゅう', 'drill', 9999, false)
    `);
    const wrote = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from locations where id = ${probe}`,
    );
    if (wrote.rows[0]?.n !== 1) {
      console.error("  ★書き込めませんでした★");
      return;
    }
    await db.execute(sql`delete from locations where id = ${probe}`);
    console.log(`  書き込み           できた（制約と索引は生きている）`);

    // 生成列が計算し直されているか（restore では入れずに DB に作らせている）
    const generated = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from listings
      where search_text is null or search_text = ''
    `);
    const listingCount =
      backup.tables.find((t) => t.table === "listings")?.rows ?? 0;
    console.log(
      `  生成列             ${listingCount} 件中 ${generated.rows[0]?.n ?? 0} 件が空（0 なら正常）`,
    );

    ok = true;
    console.log(`\n■ 完了 — 合計 ${seconds(started)}`);
    console.log(
      [
        "",
        "★これで確かめられたこと★",
        "  ・手順が最後まで通る（器を作る → 流し込む → 確かめる）",
        "  ・本物の本番データで、件数も中身も戻る",
        "  ・戻したあとに書き込める",
        "",
        "★確かめられていないこと★",
        "  ・東京の Supabase への往復時間",
        "    （使い捨てプロジェクトが要る。無料枠は本番2つで埋まっている）",
        "",
        "実施日と所要時間を OPERATIONS.md の「復旧の記録」へ書き足してください。",
        "写し（" + file + "）も忘れずに消してください。",
      ].join("\n"),
    );
  } finally {
    await pool.end();
    await server.stop();
    await pglite.close();
    if (!ok) process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("\n練習に失敗しました:", describeError(error));
  process.exitCode = 1;
});
