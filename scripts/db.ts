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

/**
 * 接続先。
 *
 * ★2026-08-18、本番は Neon（シンガポール）から Supabase（東京）へ移した。★
 *  - production      … Supabase。ホストは db.<ref>.supabase.co、データベースは postgres
 *  - production-neon … 移行元の Neon。退避路として当面残す（数日様子を見て消す）
 * dev / preview は引き続き Neon（gentle-wildflower プロジェクト）。
 */
/**
 * `drill` は復旧の練習用。★使い捨ての空の Supabase プロジェクトを指す。★
 *
 * 本番の写しを実際に戻して、所要時間を測るために使う。dev や preview を
 * 使わないのは、**本番の個人情報が検証環境へ移ってしまう**ため
 * （利用者のメッセージ・暗号化済みメールアドレス・復号できるIPが入っている）。
 * 練習が終わったらプロジェクトごと削除する。
 */
export type DbTarget =
  | "dev"
  | "preview"
  | "production"
  | "production-neon"
  | "drill";

/** 環境ごとの、期待するデータベース名。貼り間違いを検出するために使う */
const EXPECTED_DATABASE: Readonly<Record<DbTarget, string>> = {
  dev: "nakadachi_dev",
  preview: "nakadachi_preview",
  // Supabase は1プロジェクト＝1データベース（postgres）。名前で環境を見分けられないので、
  // 下の EXPECTED_HOST でプロジェクトの ref まで見る。
  production: "postgres",
  "production-neon": "nakadachi",
  drill: "postgres",
};

/**
 * 本番（Supabase）の期待するホスト。プロジェクトの ref を含むので取り違えられない。
 * ★ref は秘密ではない。★ 接続にはロールとパスワードが要る。
 */
const SUPABASE_PRODUCTION_HOST = "db.eejuzgepfjkfscutstdm.supabase.co";

/**
 * 期待する Neon のエンドポイント（ホスト名の先頭）。
 *
 * ★データベース名だけでは足りない。★ 本番は 2026-08-14 に専用の Neon
 * プロジェクトへ移したが、移行元にも同じ名前（nakadachi）のデータベースが
 * 残っている。名前だけを見る検査では、古いほうを指していても素通りする。
 * 「本番のつもりで、誰も見ていない古いDBへマイグレーションを流した」は
 * 気づくのが遅れるほど痛い。ホストまで見る。
 *
 * ★エンドポイント名は秘密ではない。★ 接続にはロールとパスワードが要る。
 */
const EXPECTED_HOST_PREFIX: Readonly<Partial<Record<DbTarget, string>>> = {
  "production-neon": "ep-lucky-brook-",
};

const ENV_VARIABLE: Readonly<Record<DbTarget, string>> = {
  dev: "DATABASE_URL_DEV",
  preview: "DATABASE_URL_PREVIEW",
  production: "DATABASE_URL_PRODUCTION",
  "production-neon": "DATABASE_URL_PRODUCTION_NEON",
  drill: "DATABASE_URL_DRILL",
};

/** Supabase の接続文字列か（ホストで見る） */
export function isSupabaseUrl(value: string): boolean {
  return /@db\.[a-z0-9]+\.supabase\.co[:/]/.test(value);
}

export function parseTarget(value: string | undefined): DbTarget {
  if (
    value === "preview" ||
    value === "production" ||
    value === "production-neon" ||
    value === "dev" ||
    value === "drill"
  ) {
    return value;
  }
  if (value === undefined) return "dev";
  throw new Error(
    `接続先の指定が不正です: ${value}（dev / preview / production / production-neon / drill のいずれか）`,
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
      `${variable} が未設定です。.env.example をコピーして .env を作り、接続文字列を書いてください。`,
    );
  }
  if (value.includes("REPLACE_ME") || value.includes("PASSWORD_HERE")) {
    throw new Error(`${variable} がひな型のままです。実際の接続文字列に置き換えてください。`);
  }

  /*
   * ★Supabase（本番）。★ データベース名は常に postgres なので、環境の取り違えは
   * ホスト（プロジェクトの ref）で見る。Hyperdrive もスクリプトも Direct connection
   * （5432）を使う。プーラー（6543 / pooler.supabase.com）は使わない
   * （Hyperdrive が自前でプールする。二重にプールしない）。
   */
  if (isSupabaseUrl(value)) {
    if (target !== "production" && target !== "drill") {
      throw new Error(
        `${variable} が Supabase を指していますが、${target} は Neon のはずです。`,
      );
    }

    /*
     * ★練習用は、本番のプロジェクトを指していたら必ず止める。★
     *
     * drill は「使い捨ての空のプロジェクトへ本番の写しを流し込んで、
     * 所要時間を測る」ためのもの。流し込みは --replace で
     * **対象の表を全部空にしてから**入れるので、ここが本番を向いていたら
     * ★本番を消して古い写しで上書きする★。復旧の練習で本番を壊すのは
     * いちばん間抜けな壊し方なので、環境変数の貼り間違いで済むように
     * しない。ref をそのまま見る。
     */
    if (target === "drill" && value.includes(`@${SUPABASE_PRODUCTION_HOST}`)) {
      throw new Error(
        `★${variable} が本番のプロジェクト（${SUPABASE_PRODUCTION_HOST}）を指しています。★ ` +
          `drill は使い捨ての空プロジェクト専用です。本番を消してしまうので実行しません。`,
      );
    }
    if (target === "production" && !value.includes(`@${SUPABASE_PRODUCTION_HOST}`)) {
      throw new Error(
        `${variable} が想定と違う Supabase プロジェクトを指しています（本番は ${SUPABASE_PRODUCTION_HOST}）。`,
      );
    }

    // プーラー（6543 / pooler.supabase.com）は使わない。Direct connection のみ。
    if (value.includes("pooler.supabase.com") || value.includes(":6543")) {
      throw new Error(
        `${variable} がプーラーを指しています。Direct connection（db.<ref>.supabase.co:5432）を使ってください。`,
      );
    }

    const dbName = /\/([A-Za-z0-9_]+)(\?|$)/.exec(value)?.[1];
    if (dbName !== "postgres") {
      throw new Error(`${variable} のデータベース名が postgres ではありません（${dbName ?? "不明"}）。`);
    }
    return value;
  }
  if (target === "production") {
    throw new Error(
      `${variable} が Supabase（${SUPABASE_PRODUCTION_HOST}）を指していません。本番は 2026-08-18 に Supabase へ移りました。Neon を指すなら production-neon を使ってください。`,
    );
  }
  if (target === "drill") {
    throw new Error(
      `${variable} が Supabase を指していません。drill は使い捨ての Supabase プロジェクト（db.<ref>.supabase.co:5432）専用です。` +
        `★dev や preview を練習に使わないでください。★ 本番の個人情報が検証環境へ移ります。`,
    );
  }

  /*
   * ローカルの使い捨て DB（CI のサービスコンテナなど）は、以下の検査を飛ばす。
   * どちらの検査も「Neon の本番／preview を取り違えない」ためのもので、
   * localhost の空の DB には意味がない。ここを通せないと CI で E2E に
   * データベースを与えられず、DB を使う画面が一切検査できなくなる。
   */
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(value)) return value;

  // ★指定した環境と、接続文字列が指すデータベースが一致するか。★
  const expected = EXPECTED_DATABASE[target];
  const actual = /\/([A-Za-z0-9_]+)(\?|$)/.exec(value)?.[1];
  if (actual !== expected) {
    throw new Error(
      `${variable} の接続先が「${actual ?? "不明"}」になっています。` +
        `${target} には「${expected}」を指定してください（貼り間違いの可能性があります）。`,
    );
  }

  // ★エンドポイントも見る。★ 同名のデータベースが別プロジェクトに残っている。
  const hostPrefix = EXPECTED_HOST_PREFIX[target];
  if (hostPrefix && !value.includes(`@${hostPrefix}`)) {
    throw new Error(
      `${variable} が想定と違う Neon エンドポイントを指しています` +
        `（${target} は ${hostPrefix}… のプロジェクト）。` +
        `分離前の古いデータベースを掴んでいないか確認してください。`,
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
  if (target !== "production" && target !== "production-neon") return;
  if (process.argv.includes("--yes")) return;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\n★本番データベース（${describeTarget(target)}）に対して「${action}」を実行します。★\n続けるには ${target} と入力してください: `,
  );
  rl.close();

  if (answer.trim() !== target) {
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
    // Neon も Supabase も TLS で繋ぐ。ローカルの PGlite などでは無効になる。
    // Supabase の Direct connection は証明書チェーンが素の pg で検証できない
    // （自己署名の CA。sslmode=verify-full には CA の配布が要る）ため、暗号化のみ。
    ssl: connectionString.includes("neon.tech")
      ? { rejectUnauthorized: true }
      : isSupabaseUrl(connectionString)
        ? { rejectUnauthorized: false }
        : undefined,
  });

  return {
    db: asDb(drizzle(pool, { schema, casing: "snake_case" })),
    pool,
  };
}

/** 接続先を、秘密を出さずに1行で説明する */
export function describeTarget(target: DbTarget): string {
  const where =
    target === "production"
      ? "Supabase 東京"
      : target === "production-neon"
        ? "Neon シンガポール・移行元"
        : target === "drill"
          ? "★復旧の練習用・使い捨ての Supabase★"
          : "Neon";
  return `${target}（${where} / データベース: ${EXPECTED_DATABASE[target]}）`;
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
