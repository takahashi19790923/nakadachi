import "dotenv/config";

import { seedAll } from "../app/db/seed/seed.ts";
import {
  confirmIfProduction,
  createScriptDb,
  describeTarget,
  parseTarget,
  requireConnectionString,
} from "./db.ts";

/**
 * 初期データの投入。
 *
 *   pnpm run db:seed                  → dev
 *   pnpm run db:seed -- preview       → preview
 *   pnpm run db:seed -- production    → 本番（確認あり）
 *
 * 何度流しても同じ結果になる（既存の行は更新し、消さない）。
 */
async function main(): Promise<void> {
  const target = parseTarget(process.argv[2]);
  const url = requireConnectionString(target);
  await confirmIfProduction(target, "初期データの投入");

  const { db, pool } = createScriptDb(url);

  console.log(`初期データを投入します → ${describeTarget(target)}`);
  try {
    const result = await seedAll(db);
    console.log(
      `カテゴリ ${result.categories} / 都道府県 ${result.prefectures} / 市区町村 ${result.cities} / 禁止ワード ${result.bannedWords}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    "seed に失敗しました:",
    error instanceof Error ? error.message.slice(0, 300) : String(error),
  );
  process.exitCode = 1;
});
