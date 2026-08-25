import "dotenv/config";
import pg from "pg";

import { requireConnectionString } from "./db.ts";

/**
 * Supabase（本番）の DB を締める。★何度実行してもよい。★
 * （2026-08-19 の公開前セキュリティ監査で追加）
 *
 * ■ 何を直すのか
 * Supabase はプロジェクトを作った時点で、PostgREST（Data API）用の役割
 * `anon` と `authenticated` に **public スキーマの全テーブルへ
 * SELECT / INSERT / UPDATE / DELETE / TRUNCATE を与える**。
 * さらに、この既定のままだと RLS はどのテーブルでも無効。
 *
 * ★`anon` は「公開してよい鍵」で名乗れる役割である。★ Supabase の設計では
 * publishable（anon）キーはクライアントに埋め込む前提で、守るのは RLS の側。
 * このアプリは Data API を使わず（作成時にオフ）、Postgres へ直接繋いでいるので
 * その鍵はどこにも出していない。しかし
 *   - ダッシュボードのトグル1つで Data API は有効になる
 *   - 別のチャットや将来の自分が「便利だから」と有効にしうる
 *   - 鍵は設計上「公開してよい」ものなので、漏れても事故と見なされにくい
 * という状態で、★有効化された瞬間に全テーブルが誰でも読み書き可能になる。★
 * 監査（2026-08-19）時点で 24 表すべてが RLS 無効・ポリシー 0 件だった。
 *
 * ■ どう直すか
 *   1. `anon` / `authenticated` から public スキーマの権限を全部剥がす
 *   2. 既定権限も剥がす（次のマイグレーションで作る表に付け直されないように）
 *   3. 全テーブルで RLS を有効にする（多層防御）
 *   4. アプリ用ロールに BYPASSRLS を与える（アプリの認可はアプリ層で行うため）
 *
 * ★アプリの認可を RLS へ移していないのは意図的。★ 所有者判定・管理者判定は
 * guards.server.ts に集約してテストしてある。同じ規則を SQL 側にも書くと、
 * 二重管理になって片方だけ古くなる。ここでの RLS は「Data API から来る
 * 見知らぬ役割を全部落とす」ための網であって、業務ロジックではない。
 *
 * ■ 使い方
 *   pnpm run db:harden          … 現状を表示するだけ（何も変えない）
 *   pnpm run db:harden -- --apply … 実際に締める
 */

const APPLY = process.argv.includes("--apply");

/** Data API の身元。★この2つに public の権限を持たせない。★ */
const PUBLIC_ROLES = ["anon", "authenticated"] as const;
const APP_ROLE = "nakadachi_app_production";

interface Status {
  tablesWithoutRls: number;
  tablesTotal: number;
  publicRoleGrants: number;
  appRoleBypassRls: boolean;
  /** 監査表に対する削除・更新の権限（0 であるべき） */
  auditWriteGrants: number;
}

async function readStatus(c: pg.Client): Promise<Status> {
  const rls = await c.query<{ total: string; without: string }>(`
    select count(*)::text as total,
           count(*) filter (where not c.relrowsecurity)::text as without
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  `);
  const grants = await c.query<{ n: string }>(`
    select count(*)::text as n from information_schema.role_table_grants
    where table_schema = 'public' and grantee = any($1::text[])
  `, [PUBLIC_ROLES]);
  const bypass = await c.query<{ b: boolean }>(
    `select coalesce(bool_or(rolbypassrls), false) as b from pg_roles where rolname = $1`,
    [APP_ROLE],
  );
  /*
   * ★監査の記録を消せないこと。★ アプリを乗っ取られたとき、
   * 足跡だけを消せる状態にしない。コード側は insert しかしていない。
   */
  const audit = await c.query<{ n: string }>(`
    select count(*)::text as n from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('audit_logs', 'admin_actions')
      and grantee = $1
      and privilege_type in ('DELETE', 'UPDATE', 'TRUNCATE')
  `, [APP_ROLE]);

  return {
    auditWriteGrants: Number(audit.rows[0]!.n),
    tablesTotal: Number(rls.rows[0]!.total),
    tablesWithoutRls: Number(rls.rows[0]!.without),
    publicRoleGrants: Number(grants.rows[0]!.n),
    appRoleBypassRls: bypass.rows[0]!.b,
  };
}

function show(label: string, s: Status): void {
  console.log(`\n[${label}]`);
  console.log(`  RLS 無効のテーブル      : ${s.tablesWithoutRls} / ${s.tablesTotal}`);
  console.log(`  監査表の削除・更新権限  : ${s.auditWriteGrants} 件`);
  console.log(`  anon/authenticated の権限: ${s.publicRoleGrants} 件`);
  console.log(`  アプリロールの BYPASSRLS : ${s.appRoleBypassRls ? "あり" : "なし"}`);
}

async function main(): Promise<void> {
  const c = new pg.Client({
    connectionString: requireConnectionString("production"),
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  try {
    const before = await readStatus(c);
    show("現在", before);

    if (!APPLY) {
      console.log("\n下見だけです。実際に締めるには --apply を付けてください。");
      return;
    }

    await c.query("begin");
    try {
      // 1. Data API の役割から public スキーマの権限を全部剥がす。
      for (const role of PUBLIC_ROLES) {
        await c.query(`revoke all privileges on all tables in schema public from ${role}`);
        await c.query(`revoke all privileges on all sequences in schema public from ${role}`);
        await c.query(`revoke all privileges on all functions in schema public from ${role}`);
        await c.query(`revoke usage on schema public from ${role}`);
      }

      /*
       * 2. 既定権限も剥がす。★これを忘れると次のマイグレーションで穴が戻る。★
       *    Supabase は postgres と supabase_admin が作る表に既定で付与するので、
       *    両方について取り消す（supabase_admin は権限が無ければ黙って飛ばす）。
       */
      for (const owner of ["postgres", "supabase_admin"]) {
        for (const role of PUBLIC_ROLES) {
          for (const kind of ["tables", "sequences", "functions"]) {
            /*
             * ★セーブポイントで囲む。★ トランザクションの中では1文でも失敗すると
             * 以降が全部「current transaction is aborted」になる。.catch() では
             * 握れない（握った次の文が落ちる）。存在しないロールは飛ばしたいので、
             * 文ごとに戻せるようにする。
             */
            await c.query("savepoint dp");
            try {
              await c.query(
                `alter default privileges for role ${owner} in schema public revoke all on ${kind} from ${role}`,
              );
              await c.query("release savepoint dp");
            } catch {
              await c.query("rollback to savepoint dp");
            }
          }
        }
      }

      // 3. 全テーブルで RLS を有効にする（ポリシーは置かない＝既定で全拒否）。
      //    所有者（postgres）は FORCE していないので素通りし、マイグレーションは動く。
      const tables = await c.query<{ relname: string }>(`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
      `);
      for (const t of tables.rows) {
        await c.query(`alter table public."${t.relname}" enable row level security`);
      }

      /*
       * 4. アプリ用ロールは RLS を素通りする。
       *    ★ここを忘れるとサイトが全面停止する。★ ポリシーが1つも無いので、
       *    BYPASSRLS が無い役割はどの表も読めない。create-app-role.ts でも
       *    同じ属性を付けている（ロールを作り直したときに落ちないように）。
       */
      await c.query(`alter role ${APP_ROLE} bypassrls`);

      /*
       * 5. 監査の記録は書き足せるが消せない。
       *    audit_logs と admin_actions は、事故のあとで「誰が何をしたか」を
       *    確かめるためのもの。アプリから消せると、乗っ取った相手が
       *    ★自分の足跡だけを消せる★。コード側は insert しかしていない
       *    （2026-08-25 に全参照を確認）ので、取り上げても機能は壊れない。
       *    保持期間の掃除を足すときは、ここを戻すのではなく専用の役割を作る。
       */
      for (const t of ["audit_logs", "admin_actions"]) {
        await c.query(
          `revoke delete, update, truncate on public."${t}" from ${APP_ROLE}`,
        );
      }

      await c.query("commit");
    } catch (error) {
      await c.query("rollback");
      throw error;
    }

    const after = await readStatus(c);
    show("適用後", after);

    const ok =
      after.publicRoleGrants === 0 &&
      after.tablesWithoutRls === 0 &&
      after.appRoleBypassRls &&
      after.auditWriteGrants === 0;
    console.log(
      ok
        ? "\n締めました（anon/authenticated の権限 0 件・全表 RLS 有効・アプリロールは素通り・監査表は追記のみ）。"
        : "\n★まだ残っています。上の数字を確認してください。★",
    );
    if (!ok) process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main().catch((error: unknown) => {
  // ★接続文字列を出力しない。★
  console.error("失敗しました:", error instanceof Error ? error.message.slice(0, 400) : String(error));
  process.exitCode = 1;
});
