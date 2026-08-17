import "dotenv/config";
import pg from "pg";

import { requireConnectionString } from "./db.ts";

/**
 * Neon（production-neon）から Supabase（production）へ、行をそのまま移す。
 * （2026-08-18。vtuber-sns の scripts/migrate-to-supabase.mjs を下敷きにした）
 *
 * ★pg_dump を使わない★
 *   この PC に pg_dump が無く、Docker も動かない。データは小さい
 *   （21表・数百行）ので、素の SELECT / INSERT で足りる。依存は既にある pg だけ。
 *
 * ★スキーマは drizzle のマイグレーションが作る★
 *   このスクリプトは行だけを移す。先に `pnpm run db:migrate production` を
 *   当てておくこと。手でスキーマを作らないのは、本番と定義がずれるのを防ぐため。
 *
 * ★接続文字列は .env から読む★
 *   引数に書くとコマンド履歴とプロセス一覧に残る。取り違えの検査
 *   （scripts/db.ts）もそのまま効く。
 *
 * ★既定は下見（何も書かない）★
 *   実際に書くのは --apply を付けたときだけ。書くときは移行先の全表を
 *   1つのトランザクションの中で TRUNCATE してから入れる（やり直せる）。
 *   ★移行元には一切書かない。★
 *
 * 使い方:
 *   pnpm exec node --experimental-strip-types scripts/migrate-to-supabase.ts          … 件数を並べて見せるだけ
 *   pnpm exec node --experimental-strip-types scripts/migrate-to-supabase.ts --apply  … 実際に移す（終わったら件数を照合）
 */

const APPLY = process.argv.includes("--apply");
const BATCH = 500;

/**
 * 外部キーの親が先になる順。app/server/services/backup-service.server.ts と同じ並び。
 * ★drizzle のマイグレーション表（drizzle.__drizzle_migrations）は移さない。★
 * 移行先で db:migrate を流したときにあちらで作られる。
 */
const TABLES = [
  "locations",
  "categories",
  "banned_words",
  "users",
  "user_profiles",
  // バックアップには入れていない一時的な表。★移行では運ぶ。★ 運ばないと切替の
  // 瞬間に全員がログアウトされ、確認コードも無効になる。
  "sessions",
  "email_verification_tokens",
  "rate_limits",
  "listings",
  "listing_category_details",
  "listing_images",
  "favorites",
  "conversation_threads",
  "conversation_participants",
  "messages",
  "blocks",
  "reports",
  "payments",
  "payment_webhook_events",
  "audit_logs",
  "admin_actions",
  "account_deletion_requests",
  "access_records",
  "email_delivery_logs",
] as const;

function client(url: string): pg.Client {
  return new pg.Client({
    connectionString: url,
    ssl: url.includes("neon.tech")
      ? { rejectUnauthorized: true }
      : { rejectUnauthorized: false },
  });
}

async function countAll(c: pg.Client): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const r = await c.query<{ n: string }>(`select count(*)::text as n from "${t}"`);
    out[t] = Number(r.rows[0]?.n ?? 0);
  }
  return out;
}

/** 生成列（GENERATED ALWAYS）は INSERT に含められない。移行先で調べて除く */
async function insertableColumns(c: pg.Client, table: string): Promise<string[]> {
  const r = await c.query<{ column_name: string }>(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER'
     order by ordinal_position`,
    [table],
  );
  return r.rows.map((row) => row.column_name);
}

async function main(): Promise<void> {
  const from = client(requireConnectionString("production-neon"));
  const to = client(requireConnectionString("production"));
  await from.connect();
  await to.connect();

  try {
    const before = await countAll(from);
    const dest = await countAll(to);
    console.log(`${"表".padEnd(28)} 移行元(Neon)  移行先(Supabase)`);
    let total = 0;
    for (const t of TABLES) {
      console.log(`${t.padEnd(28)} ${String(before[t]).padStart(10)}  ${String(dest[t]).padStart(14)}`);
      total += before[t] ?? 0;
    }
    console.log(`合計 ${total} 行`);

    if (!APPLY) {
      console.log("\n下見だけです。実際に移すには --apply を付けてください。");
      return;
    }

    await to.query("begin");
    try {
      // 逆順に空にする（子から）。同じトランザクションなので失敗すれば全部戻る。
      for (const t of [...TABLES].reverse()) {
        await to.query(`truncate table "${t}" cascade`);
      }

      for (const t of TABLES) {
        const cols = await insertableColumns(to, t);
        const quoted = cols.map((c) => `"${c}"`).join(", ");
        const rows = await from.query(`select ${quoted} from "${t}"`);
        for (let i = 0; i < rows.rows.length; i += BATCH) {
          const chunk = rows.rows.slice(i, i + BATCH);
          const values: unknown[] = [];
          const tuples = chunk.map((row: Record<string, unknown>, ri: number) => {
            const ph = cols.map((c, ci) => {
              values.push(row[c]);
              return `$${ri * cols.length + ci + 1}`;
            });
            return `(${ph.join(", ")})`;
          });
          await to.query(`insert into "${t}" (${quoted}) values ${tuples.join(", ")}`, values);
        }
        console.log(`  ${t}: ${rows.rows.length} 行`);
      }
      await to.query("commit");
    } catch (error) {
      await to.query("rollback");
      throw error;
    }

    // ★件数を照合する。★ 移行元は読み取りだけなので、この間に変わっていなければ一致する。
    const after = await countAll(to);
    const again = await countAll(from);
    let ok = true;
    for (const t of TABLES) {
      if (after[t] !== again[t]) {
        ok = false;
        console.log(`★不一致★ ${t}: 移行元 ${again[t]} / 移行先 ${after[t]}`);
      }
    }
    console.log(ok ? "\n件数はすべて一致しました。" : "\n★件数が一致しません。移行元に書き込みがあったか確認してください。★");
    if (!ok) process.exitCode = 1;
  } finally {
    await from.end();
    await to.end();
  }
}

main().catch((error: unknown) => {
  // ★接続文字列を出力しない。★
  console.error("失敗しました:", error instanceof Error ? error.message.slice(0, 400) : String(error));
  process.exitCode = 1;
});
