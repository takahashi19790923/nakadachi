import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { eq } from "drizzle-orm";

import { users } from "../app/db/schema/index.ts";
import { emailIndexHmac, encryptString } from "../app/server/crypto.server.ts";
import { ulid } from "../app/domain/ulid.ts";
import { userProfiles } from "../app/db/schema/index.ts";
import {
  confirmIfProduction,
  createScriptDb,
  describeTarget,
  parseTarget,
  requireConnectionString,
} from "./db.ts";

/**
 * 初期管理者の作成。
 *
 *   pnpm run admin:create                 → dev
 *   pnpm run admin:create preview         → preview
 *   pnpm run admin:create production      → 本番（確認あり）
 *
 * ★メールアドレスをコマンドライン引数で渡さない。★ PowerShell の履歴
 * （ConsoleHost_history.txt）に平文で残る。対話で入力させる。
 *
 * ★管理者は運営者本人のアドレス1つのみ。★ 他のアドレスに管理権限を
 * 与えないこと。全サービスで同じ運用にしている。
 *
 * ★鍵はその環境へ投入したものと同じでなければならない。★
 * 違う鍵で作ると、メールアドレスの索引（HMAC）が一致せず、
 * 「作成は成功したのにログインできない管理者」ができる。しかも
 * ログイン画面は「確認コードを送りました」と正常に応答するので気づけない。
 *
 * 環境ごとの鍵を .env の EMAIL_ENCRYPTION_KEY_PREVIEW のような名前で持ち、
 * 無ければ環境なしの名前に落ちる（dev はこちら）。
 */
function requireKey(base: string, target: string): string {
  const scoped = process.env[`${base}_${target.toUpperCase()}`];
  const fallback = process.env[base];
  const value = scoped ?? fallback;
  if (!value) {
    throw new Error(
      `${base}_${target.toUpperCase()}（または ${base}）を .env に設定してください。` +
        `★その環境の Worker へ投入したものと同じ値であること。★`,
    );
  }
  return value;
}

async function main(): Promise<void> {
  const target = parseTarget(process.argv[2]);
  const url = requireConnectionString(target);
  await confirmIfProduction(target, "管理者の作成");
  console.log(`管理者を作成します → ${describeTarget(target)}`);

  const encryptionKey = requireKey("EMAIL_ENCRYPTION_KEY", target);
  const indexKey = requireKey("EMAIL_INDEX_KEY", target);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const email = (await rl.question("管理者のメールアドレス: ")).trim();
  rl.close();

  if (!email.includes("@")) {
    throw new Error("メールアドレスの形式が不正です。");
  }

  const { db, pool } = createScriptDb(url);
  try {
    const emailHmac = await emailIndexHmac(indexKey, email);

    const existing = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.emailHmac, emailHmac))
      .limit(1);

    const found = existing[0];
    if (found) {
      if (found.role === "admin") {
        console.log("すでに管理者です。変更はありません。");
        return;
      }
      await db
        .update(users)
        .set({ role: "admin", updatedAt: new Date() })
        .where(eq(users.id, found.id));
      console.log("既存の利用者を管理者に変更しました。");
      return;
    }

    const id = ulid();
    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id,
        emailEncrypted: await encryptString(encryptionKey, email.toLowerCase()),
        emailHmac,
        role: "admin",
      });
      await tx.insert(userProfiles).values({
        userId: id,
        displayName: "運営",
      });
    });

    console.log("管理者を作成しました。");
    console.log(
      "この後、通常のログイン画面からメールで確認コードを受け取ってログインしてください。",
    );
    console.log(
      "管理画面に入るには、さらに /admin/gate で再確認と追加の資格情報が必要です。",
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // ★アドレスを出力しない。★
  console.error(
    "管理者の作成に失敗しました:",
    error instanceof Error ? error.message.slice(0, 200) : String(error),
  );
  process.exitCode = 1;
});
