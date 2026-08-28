import "dotenv/config";
import { eq, isNull } from "drizzle-orm";

import { users } from "../app/db/schema/index.ts";
import {
  decryptString,
  emailCanonicalHmac,
} from "../app/server/crypto.server.ts";
import {
  confirmIfProduction,
  createScriptDb,
  describeError,
  describeTarget,
  parseTarget,
  requireConnectionString,
} from "./db.ts";

/**
 * 既存の利用者に「同じ受信箱か」の索引を埋める。
 *
 *   pnpm run db:backfill-canonical <対象>
 *
 * ★埋めないと、既存の利用者には停止の回避防止が効かない。★
 * 列を足しただけの状態では email_canonical_hmac が NULL で、
 * 「同じ受信箱に停止された人がいるか」の検索に引っかからない。
 * つまり★いま登録済みの人を止めても、点を足せば再登録できる★。
 *
 * 何度実行してもよい（NULL の行だけを対象にする）。
 *
 * ★平文のアドレスをこのプロセスの外へ出さない。★ 復号するのは
 * ハッシュを作るためだけで、画面にもログにも出さない。
 * 実行には EMAIL_ENCRYPTION_KEY と EMAIL_INDEX_KEY が要る
 * （本番は .env の *_PRODUCTION）。
 */

function keyFor(target: string, name: string): string {
  const suffix =
    target === "production" || target === "production-neon"
      ? "_PRODUCTION"
      : target === "preview"
        ? "_PREVIEW"
        : "";
  const value = process.env[`${name}${suffix}`] ?? process.env[name];
  if (!value) {
    throw new Error(
      `${name}${suffix} が未設定です。復号と索引の作成に必要です。`,
    );
  }
  return value;
}

async function main(): Promise<void> {
  const target = parseTarget(process.argv[2]);
  const encryptionKey = keyFor(target, "EMAIL_ENCRYPTION_KEY");
  const indexKey = keyFor(target, "EMAIL_INDEX_KEY");

  console.log(`\n対象: ${describeTarget(target)}`);
  await confirmIfProduction(target, "受信箱の索引を埋める");

  const { db, pool } = createScriptDb(requireConnectionString(target));
  try {
    const rows = await db
      .select({ id: users.id, emailEncrypted: users.emailEncrypted })
      .from(users)
      .where(isNull(users.emailCanonicalHmac));

    console.log(`未設定の利用者: ${rows.length} 件`);
    if (rows.length === 0) {
      console.log("何もすることがありません。");
      return;
    }

    let done = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        // ★平文はこのスコープの外へ出さない。★
        const email = await decryptString(encryptionKey, row.emailEncrypted);
        const hmac = await emailCanonicalHmac(indexKey, email);
        await db
          .update(users)
          .set({ emailCanonicalHmac: hmac })
          .where(eq(users.id, row.id));
        done += 1;
      } catch (error) {
        failed += 1;
        // ★どの行で失敗したかは ID だけ出す。★ アドレスは出さない。
        console.error(`  失敗 ${row.id}: ${describeError(error)}`);
      }
    }

    console.log(`\n埋めました: ${done} 件 / 失敗: ${failed} 件`);

    const left = await db
      .select({ id: users.id })
      .from(users)
      .where(isNull(users.emailCanonicalHmac));
    console.log(`残りの未設定: ${left.length} 件（0 が正常）`);
    if (left.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("\n失敗しました:", describeError(error));
  process.exitCode = 1;
});
