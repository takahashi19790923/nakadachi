import { createInterface } from "node:readline/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

// ★db.server.ts からは import しないこと。★ あちらは `~/` 別名を使っており、
// 素の Node（--experimental-strip-types）では解決できない。
import { asDb, type Db } from "../app/db/db-type.ts";
import * as schema from "../app/db/schema/index.ts";

/**
 * Node 側のスクリプトから使う DB クライアントと、接続先の選択。
 *
 * アプリ本体は Neon の serverless ドライバ（Workers 用）を使うが、
 * マイグレーション・seed・定期処理は Node で動くので node-postgres を使う。
 * Drizzle の公開 API は同一なので、型だけを合わせて使い回す。
 */

export type DbTarget = "dev" | "preview" | "production";

/** 環境ごとの、期待するデータベース名。貼り間違いを検出するために使う */
const EXPECTED_DATABASE: Readonly<Record<DbTarget, string>> = {
  dev: "nakadachi_dev",
  preview: "nakadachi_preview",
  production: "nakadachi",
};

const ENV_VARIABLE: Readonly<Record<DbTarget, string>> = {
  dev: "DATABASE_URL_DEV",
  preview: "DATABASE_URL_PREVIEW",
  production: "DATABASE_URL_PRODUCTION",
};

export function parseTarget(value: string | undefined): DbTarget {
  if (value === "preview" || value === "production" || value === "dev") {
    return value;
  }
  if (value === undefined) return "dev";
  throw new Error(
    `接続先の指定が不正です: ${value}（dev / preview / production のいずれか）`,
  );
}

/**
 * 接続文字列を取り出す。
 *
 * ★環境を取り違えないための検査をここに集約している。★
 * 「preview のつもりで本番へ seed を流した」「テストで本番を消した」は
 * 実際に起きる事故で、起きたときの被害が大きい。仕組みで止める。
 */
export function requireConnectionString(target: DbTarget): string {
  const variable = ENV_VARIABLE[target];
  // 移行期の互換: DATABASE_URL しか無い環境でも dev としては動かす。
  const value = process.env[variable] ?? (target === "dev" ? process.env.DATABASE_URL : undefined);

  if (!value) {
    throw new Error(
      `${variable} が未設定です。.env.example をコピーして .env を作り、Neon の接続文字列を書いてください。`,
    );
  }
  if (value.includes("REPLACE_ME")) {
    throw new Error(`${variable} がひな型のままです。実際の接続文字列に置き換えてください。`);
  }

  // ★指定した環境と、接続文字列が指すデータベースが一致するか。★
  const expected = EXPECTED_DATABASE[target];
  const actual = /\/([A-Za-z0-9_]+)(\?|$)/.exec(value)?.[1];
  if (actual !== expected) {
    throw new Error(
      `${variable} の接続先が「${actual ?? "不明"}」になっています。` +
        `${target} には「${expected}」を指定してください（貼り間違いの可能性があります）。`,
    );
  }

  // ★Workers は接続数が読めないので、必ず pooled を使う。★
  if (!value.includes("-pooler")) {
    throw new Error(
      `${variable} が pooled ではありません。Neon の Connect 画面で「Connection pooling」を ON にした文字列（ホスト名に -pooler が入る）を使ってください。`,
    );
  }

  return value;
}

/**
 * 本番に触るときは、必ず人に確認させる。
 * --yes を付ければ飛ばせる（CI や自動化のため）。
 */
export async function confirmIfProduction(
  target: DbTarget,
  action: string,
): Promise<void> {
  if (target !== "production") return;
  if (process.argv.includes("--yes")) return;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\n★本番データベース（nakadachi）に対して「${action}」を実行します。★\n続けるには production と入力してください: `,
  );
  rl.close();

  if (answer.trim() !== "production") {
    throw new Error("中止しました。");
  }
}

export function createScriptDb(connectionString: string): {
  db: Db;
  pool: pg.Pool;
} {
  const pool = new pg.Pool({
    connectionString,
    // スクリプトは直列に流すので1本で足りる。
    max: 1,
    // Neon は TLS 必須。ローカルの PGlite などでは無効になる。
    ssl: connectionString.includes("neon.tech")
      ? { rejectUnauthorized: true }
      : undefined,
  });

  return {
    db: asDb(drizzle(pool, { schema, casing: "snake_case" })),
    pool,
  };
}

/** 接続先を、秘密を出さずに1行で説明する */
export function describeTarget(target: DbTarget): string {
  return `${target}（データベース: ${EXPECTED_DATABASE[target]}）`;
}

/**
 * 例外を1行に落とす。
 *
 * ★cause を必ず出すこと。★ Drizzle は失敗した SQL を message にして
 * 元の例外を cause に入れる。message だけを出すと長い SQL で画面が埋まり、
 * 肝心の「なぜ落ちたか」（制約名・enum の値・NOT NULL 違反）が消える。
 *
 * ★接続文字列は伏せる。★ 認証失敗のメッセージに混ざることがある。
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    parts.push(current.message.split("\n")[0]!.slice(0, 200));
    current = current.cause;
  }
  if (parts.length === 0) parts.push(String(error));
  return parts
    .join("\n    ← ")
    .replace(/postgresql:\/\/\S+/g, "<接続文字列>");
}
