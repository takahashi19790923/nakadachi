import "dotenv/config";
import { sql } from "drizzle-orm";

import {
  createScriptDb,
  describeTarget,
  parseTarget,
  requireConnectionString,
  type DbTarget,
} from "./db.ts";

/**
 * 接続できるかだけを確かめる。★何も書き換えない。★
 *
 *   pnpm run db:check              → dev
 *   pnpm run db:check preview
 *   pnpm run db:check production   確認プロンプトは無い（読むだけなので）
 *   pnpm run db:check all          3環境まとめて
 *
 * パスワードを入れ替えたあと、3環境ぶんを一度に確かめるために使う。
 * マイグレーションで確かめると、通ったついでに本番へ DDL が流れてしまう。
 */
async function checkOne(target: DbTarget): Promise<boolean> {
  let url: string;
  try {
    url = requireConnectionString(target);
  } catch (error) {
    console.log(`NG  ${describeTarget(target)}`);
    console.log(`    ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  const { db, pool } = createScriptDb(url);
  try {
    // ★接続の可否と、中身の有無を分けて見る。★
    // まとめて1本のクエリにすると、「表がまだ無い」だけなのに
    // 「パスワードが違う」と同じ見え方になり、追う先を間違える。
    await db.execute(sql`select 1`);

    const applied = await db.execute<{ count: number }>(sql`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
    `);
    const tables = applied.rows[0]?.count ?? 0;
    if (tables === 0) {
      console.log(
        `OK  ${describeTarget(target)} — 接続できました（★マイグレーション未適用★）`,
      );
      return true;
    }

    const rows = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from locations`,
    );
    console.log(
      `OK  ${describeTarget(target)} — 表 ${tables}個 / 地域 ${rows.rows[0]?.count ?? 0}件`,
    );
    return true;
  } catch (error) {
    // ★接続文字列そのものを出さない。★ 認証失敗のメッセージに混ざることがある。
    const message = error instanceof Error ? error.message : String(error);
    console.log(`NG  ${describeTarget(target)}`);
    console.log(`    ${message.replace(/postgresql:\/\/\S+/g, "<接続文字列>").slice(0, 200)}`);
    return false;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const targets: DbTarget[] =
    arg === "all" ? ["dev", "preview", "production"] : [parseTarget(arg)];

  let allOk = true;
  for (const target of targets) {
    const ok = await checkOne(target);
    allOk = allOk && ok;
  }

  if (!allOk) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(
    "確認に失敗しました:",
    error instanceof Error ? error.message.slice(0, 300) : String(error),
  );
  process.exitCode = 1;
});
