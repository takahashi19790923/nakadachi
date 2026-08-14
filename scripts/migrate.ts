import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import {
  confirmIfProduction,
  createScriptDb,
  describeTarget,
  parseTarget,
  requireConnectionString,
} from "./db.ts";

/**
 * マイグレーションの適用。
 *
 *   pnpm run db:migrate                  → dev
 *   pnpm run db:migrate -- preview       → preview
 *   pnpm run db:migrate -- production    → 本番（確認あり）
 *
 * ★DDL 権限のあるロールで流すこと。★ アプリが実行時に使うロールには
 * DDL を与えない（SECURITY.md「DBロールの分離」）。
 *
 * 0000_extensions.sql が pg_trgm を入れる。これが先に流れないと、
 * listings の GIN 索引が作れずテーブル作成の段階で落ちる。
 */
async function main(): Promise<void> {
  const target = parseTarget(process.argv[2]);
  const url = requireConnectionString(target);
  await confirmIfProduction(target, "マイグレーションの適用");

  const { db, pool } = createScriptDb(url);

  console.log(`マイグレーションを適用します → ${describeTarget(target)}`);
  try {
    await migrate(db, { migrationsFolder: "./app/db/migrations" });
    console.log("完了しました。");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // ★接続文字列を出力しない。★ エラーメッセージに混ざることがあるので、
  // 種別だけを見せる。
  console.error(
    "マイグレーションに失敗しました:",
    error instanceof Error ? error.message.slice(0, 300) : String(error),
  );
  process.exitCode = 1;
});
