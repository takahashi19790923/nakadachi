import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

import { requireConnectionString } from "./db.ts";

/**
 * Supabase（本番）にアプリ用ロールを作り、その接続文字列を .env に書き込む。
 * （2026-08-18。SECURITY.md「DB ロールの分離」を Supabase でも守るため）
 *
 * ★パスワードは画面にもログにも出さない。★ ここで作って .env の
 * DATABASE_URL_APP_PRODUCTION に書くだけ。Hyperdrive の作成はその値を
 * 環境変数から読む別のコマンドで行う（DEPLOYMENT.md「Hyperdrive」）。
 *
 * ★Supabase では PUBLIC からの CONNECT を剥がさない。★ Supabase 自身の内部ロール
 * （supabase_admin / authenticator など）が同じ postgres データベースへ繋ぐ。
 * Neon のときは preview と本番が同居していたので剥がしたが、Supabase の
 * このプロジェクトは nakadachi の本番専用なので、越境の相手が居ない。
 *
 * 既にロールがあれば（やり直し）、パスワードだけ作り直す。
 *
 * 使い方:
 *   pnpm exec node --experimental-strip-types scripts/create-app-role.ts
 */

const ROLE = "nakadachi_app_production";

function newPassword(): string {
  // UUID v4 ×2 = 244 ビットの乱数。16進だけなので URL にそのまま入る。
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

async function main(): Promise<void> {
  const ownerUrl = requireConnectionString("production");
  const owner = new pg.Client({ connectionString: ownerUrl, ssl: { rejectUnauthorized: false } });
  await owner.connect();

  const password = newPassword();
  try {
    const exists = await owner.query<{ n: string }>(
      "select count(*)::text as n from pg_roles where rolname = $1",
      [ROLE],
    );
    // 識別子とパスワードは quote_ident / quote_literal で埋め込む（プレースホルダは DDL に使えない）。
    const passLit = await owner.query<{ q: string }>("select quote_literal($1) as q", [password]);
    const pw = passLit.rows[0]!.q;
    if (Number(exists.rows[0]?.n) > 0) {
      await owner.query(`alter role ${ROLE} with login password ${pw}`);
      console.log(`ロール ${ROLE} は既にあるので、パスワードだけ作り直しました。`);
    } else {
      await owner.query(`create role ${ROLE} with login password ${pw}`);
      console.log(`ロール ${ROLE} を作りました。`);
    }

    // SECURITY.md と同じ権限。DDL は与えない。
    await owner.query(`grant connect on database postgres to ${ROLE}`);
    await owner.query(`grant usage on schema public to ${ROLE}`);
    await owner.query(`grant select, insert, update, delete on all tables in schema public to ${ROLE}`);
    await owner.query(`grant usage, select on all sequences in schema public to ${ROLE}`);
    await owner.query(
      `alter default privileges in schema public grant select, insert, update, delete on tables to ${ROLE}`,
    );
    await owner.query(
      `alter default privileges in schema public grant usage, select on sequences to ${ROLE}`,
    );
    /*
     * ★監査の記録は、書き足せるが消せない。★
     *
     * audit_logs と admin_actions は、事故のあとで「誰が何をしたか」を
     * 確かめるためのもの。アプリからこれを消せる状態だと、
     * アプリを乗っ取った相手が★自分の足跡だけを消せる★。
     * コード側は insert しかしていない（2026-08-25 に全参照を確認）ので、
     * 削除と更新を取り上げても機能は壊れない。
     *
     * ★保持期間の掃除をここへ足すときは、専用の役割か関数を作ること。★
     * この revoke を戻すのではなく。
     */
    for (const table of ["audit_logs", "admin_actions"]) {
      await owner.query(`revoke delete, update, truncate on ${table} from ${ROLE}`);
    }

    // pg_trgm は extensions スキーマに入ることがある。索引の演算子クラスは検索パスに
    // 関係なく効くが、関数を直接呼ぶ日に備えて USAGE だけ与えておく。
    await owner.query(`grant usage on schema extensions to ${ROLE}`).catch(() => undefined);
    /*
     * ★RLS を素通りさせる。★ harden-db.ts が public の全テーブルで RLS を
     * 有効にしている（Data API の役割を締め出すため。ポリシーは1つも置かない）。
     * この属性が無いと、このロールはどの表も読めず★サイトが全面停止する。★
     * ロールを作り直したときに落ちないよう、ここでも必ず付ける。
     * アプリの認可は guards.server.ts が担当する（SQL 側には書かない）。
     */
    await owner.query(`alter role ${ROLE} bypassrls`);
    console.log("権限を付けました（SELECT / INSERT / UPDATE / DELETE、DDL 無し、RLS 素通り）。");
  } finally {
    await owner.end();
  }

  // 接続文字列を組み立てて .env に書く。★表示しない。★
  const u = new URL(ownerUrl);
  u.username = ROLE;
  u.password = password;
  // sslmode は付けない。pg のスクリプト側は ssl オプションで、Hyperdrive は既定（require）で繋ぐ。
  u.search = "";
  const appUrl = u.toString();

  const envPath = ".env";
  const text = readFileSync(envPath, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const key = "DATABASE_URL_APP_PRODUCTION=";
  const idx = lines.findIndex((l) => l.startsWith(key));
  const line = `${key}"${appUrl}"`;
  if (idx >= 0) lines[idx] = line;
  else {
    const anchor = lines.findIndex((l) => l.startsWith("DATABASE_URL_APP_PRODUCTION_NEON="));
    if (anchor >= 0) lines.splice(anchor, 0, line);
    else lines.push(line);
  }
  writeFileSync(envPath, lines.join(eol));
  console.log(".env の DATABASE_URL_APP_PRODUCTION に書き込みました（値は表示しません）。");

  // 動作確認: アプリロールで繋いで読めること・DDL ができないこと。
  const app = new pg.Client({ connectionString: appUrl, ssl: { rejectUnauthorized: false } });
  await app.connect();
  try {
    const r = await app.query<{ n: string }>("select count(*)::text as n from locations");
    console.log(`アプリロールで接続できました（locations ${r.rows[0]?.n} 件）。`);
    try {
      await app.query("create table __should_fail (id int)");
      await app.query("drop table __should_fail");
      console.log("★警告: アプリロールで DDL が通ってしまいました。権限を見直してください。★");
      process.exitCode = 1;
    } catch {
      console.log("アプリロールでは DDL ができないことを確認しました。");
    }
  } finally {
    await app.end();
  }
}

main().catch((error: unknown) => {
  console.error("失敗しました:", error instanceof Error ? error.message.slice(0, 400) : String(error));
  process.exitCode = 1;
});
