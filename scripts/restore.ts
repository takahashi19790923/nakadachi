import "dotenv/config";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import {
  confirmIfProduction,
  createScriptDb,
  describeError,
  describeTarget,
  parseTarget,
  requireConnectionString,
  type DbTarget,
} from "./db.ts";

import {
  parseBackup,
  restoreDatabase,
  verifyRestore,
} from "../app/server/services/restore-service.server.ts";

/**
 * バックアップの流し込み。
 *
 *   pnpm run db:restore <対象> <ファイル> [--replace] [--yes]
 *
 * 例:
 *   pnpm run db:restore dev ./db-backup/2026-08-25.json --replace
 *
 * ★戻す前に、必ずマイグレーションで器を作っておくこと。★
 * 写しに入っているのは行だけで、表の定義は入っていない。
 *
 *   pnpm run db:migrate <対象>
 *   pnpm run db:restore <対象> <ファイル> --replace
 *
 * ★R2 からファイルを取り出す手順は OPERATIONS.md「DB を復旧する」。★
 * ここはローカルのファイルを読むだけにしてある。復旧の場面で、
 * 資格情報の置き場所を1つ増やしたくないため。
 *
 * ★--replace は対象の表を空にしてから入れる。★ 指定しないと、
 * 行が残っている DB では何も入れずに止まる。
 */

function usage(): never {
  console.error(
    [
      "使い方: pnpm run db:restore <対象> <ファイル> [--replace] [--yes]",
      "",
      "  対象      dev | preview | production | production-neon",
      "  ファイル  書き出した JSON（R2 の db/YYYY-MM-DD.json を落としたもの）",
      "  --replace 対象の表を空にしてから入れる（復旧はこちら）",
      "  --yes     本番への確認を飛ばす",
      "",
      "★先に pnpm run db:migrate <対象> で器を作っておくこと。★",
    ].join("\n"),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const [targetArg, fileArg] = process.argv.slice(2);
  if (!targetArg || !fileArg || fileArg.startsWith("--")) usage();

  const target: DbTarget = parseTarget(targetArg);
  const replace = process.argv.includes("--replace");

  // ── ファイルを先に読んで確かめる ────────────────────────────
  // ★DB へ繋ぐ前に。★ 形が違うと分かるのに接続を張る意味がない。
  let text: string;
  try {
    text = readFileSync(fileArg, "utf8");
  } catch (error) {
    throw new Error(`ファイルを読めません: ${describeError(error)}`, {
      cause: error,
    });
  }

  const backup = parseBackup(text);
  const totalRows = backup.tables.reduce((sum, t) => sum + t.rows, 0);

  console.log(`\n読み込んだ写し: ${fileArg}`);
  console.log(`  書き出した時刻 : ${backup.exportedAt}`);
  console.log(`  書き出した環境 : ${backup.environment}`);
  console.log(`  表 / 行        : ${backup.tables.length} 表 / ${totalRows} 行`);
  console.log(`\n流し込む先: ${describeTarget(target)}`);
  console.log(`  やり方: ${replace ? "★中身を捨てて入れ替える★" : "空の DB に入れる"}`);

  /*
   * ★環境が違うときは、必ず人に確かめる。★ preview の写しを本番へ
   * 流し込むのは、事故のときにいちばん起きやすい取り違え。
   */
  const targetEnv = target.startsWith("production") ? "production" : target;
  if (backup.environment !== targetEnv) {
    console.log(
      `\n★注意★ 写しの環境（${backup.environment}）と流し込む先（${targetEnv}）が違います。`,
    );
    if (!process.argv.includes("--yes")) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question("それでも続けますか？ yes と入力してください: ");
      rl.close();
      if (answer.trim() !== "yes") throw new Error("中止しました。");
    }
  }

  await confirmIfProduction(
    target,
    replace ? "バックアップで中身を入れ替える" : "バックアップを流し込む",
  );

  const { db, pool } = createScriptDb(requireConnectionString(target));
  try {
    const started = Date.now();
    const result = await restoreDatabase({ db, backup, replace });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    console.log("\n入りました:");
    for (const row of result.tables) {
      if (row.inserted > 0) {
        console.log(`  ${row.table.padEnd(28)} ${row.inserted}`);
      }
    }

    // ★入れたあとに数え直す。★ 入れた数の自己申告ではなく、DB に聞く。
    const problems = await verifyRestore({ db, backup });
    if (problems.length > 0) {
      console.error("\n★件数が合いません★");
      for (const p of problems) console.error(`  ${p}`);
      process.exitCode = 1;
      return;
    }

    console.log(`\n完了（${elapsed} 秒）。${totalRows} 行を確認しました。`);
    console.log(
      [
        "",
        "★このあと必ず確かめること★",
        "  1. pnpm run db:check <対象>",
        "  2. 画面を開いて、一覧・詳細・ログインが動くこと",
        "  3. 新しい投稿を1件作れること（読めるだけでは «戻った» と言わない）",
        "",
        "★実施日と所要時間を OPERATIONS.md の復旧記録へ書き足すこと。★",
      ].join("\n"),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("\n流し込みに失敗しました:", describeError(error));
  process.exitCode = 1;
});
