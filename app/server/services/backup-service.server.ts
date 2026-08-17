import { sql } from "drizzle-orm";

import type { Db } from "../db.server.ts";
import type { AppEnv } from "../env.server.ts";
import type { Logger } from "../logger.server.ts";

/**
 * DB の論理バックアップ。
 *
 * ★なぜ GitHub Actions で pg_dump を回さないか。★
 * このリポジトリは public で、★Actions のアーティファクトは誰でも
 * ダウンロードできる。★ そこへ書き出すと、利用者の投稿・メッセージ・
 * 暗号化済みメールアドレス・決済記録が丸ごと公開される。
 * アーティファクトを使わない構成にしても、本番DBの資格情報を
 * GitHub に預けることになる。
 *
 * ここでは Worker の定期処理から R2 へ書く。すでにある DATABASE_URL と
 * R2 バインディングだけを使うので、★新しい資格情報をどこにも増やさない。★
 *
 * ★整形は Postgres 側にやらせる。★ Worker の CPU 上限は 1000ms しかない。
 * 行を受け取って JSON.stringify すると件数に比例して CPU を食い、
 * データが増えた日に突然落ちる。`json_agg` なら組み立ては DB 側で終わり、
 * Worker は文字列を1つ受け取って R2 へ渡すだけになる（I/O 待ちは
 * CPU 時間に入らない）。
 *
 * ★これは pg_dump の代わりにはならない。★ スキーマは含まず、行の写しだけ。
 * 復旧はマイグレーションで器を作ってから流し込む（OPERATIONS.md 参照）。
 */

/**
 * 書き出す表。
 *
 * ★順序に意味がある。★ 復旧時にこの順で流せば外部キーが満たされる。
 * 親から子へ並べること。
 */
const TABLES = [
  "locations",
  "categories",
  "banned_words",
  "users",
  "user_profiles",
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

/**
 * 1つの表で許す行数の上限。
 *
 * ★超えたら黙って切らずに失敗させる。★ 途中まで書けたバックアップは、
 * 復旧の場面で「あるのに使えない」といういちばん困る形になる。
 * ここに当たったら、表ごとに分割して書き出す実装へ変えること。
 */
const MAX_ROWS_PER_TABLE = 50_000;

/** 残す世代数。毎日なので2週間ぶん（キーは日付なので、同じ日に2回走っても増えない） */
const KEEP_GENERATIONS = 14;

export interface BackupResult {
  readonly key: string;
  readonly tables: number;
  readonly bytes: number;
}

/** R2 のキーに使う日付（UTC の YYYY-MM-DD） */
function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function exportDatabase(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  now?: Date;
}): Promise<BackupResult> {
  const { db, env, logger } = options;
  const bucket = env.BACKUPS;
  if (!bucket) {
    throw new Error("BACKUPS binding is not configured");
  }

  const stamp = today(options.now ?? new Date());
  const parts: string[] = [];

  for (const table of TABLES) {
    // 件数を先に見る。上限を超えていたら中途半端な写しを残さない。
    const countRows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from ${sql.identifier(table)}`,
    );
    const count = countRows.rows[0]?.n ?? 0;
    if (count > MAX_ROWS_PER_TABLE) {
      throw new Error(
        `table ${table} has ${count} rows (limit ${MAX_ROWS_PER_TABLE}); split the export`,
      );
    }

    /*
     * ★組み立ては DB 側。★ Worker は出来上がった文字列を受け取るだけ。
     * 空の表でも '[]' が返るようにしておく（null だと復旧側で分岐が増える）。
     */
    const rows = await db.execute<{ data: string }>(
      sql`select coalesce(json_agg(t)::text, '[]') as data from ${sql.identifier(table)} t`,
    );
    const data = rows.rows[0]?.data ?? "[]";

    parts.push(`{"table":${JSON.stringify(table)},"rows":${count},"data":${data}}`);
  }

  const body = `{"version":1,"exportedAt":${JSON.stringify(
    (options.now ?? new Date()).toISOString(),
  )},"environment":${JSON.stringify(env.ENVIRONMENT)},"tables":[${parts.join(",")}]}`;

  const key = `db/${stamp}.json`;
  await bucket.put(key, body, {
    httpMetadata: { contentType: "application/json" },
  });

  logger.info("database exported", {
    key,
    tables: TABLES.length,
    bytes: body.length,
  });

  return { key, tables: TABLES.length, bytes: body.length };
}

/**
 * 古い世代を消す。
 *
 * ★新しいほうから数えて残す。★ 日付で引き算すると、
 * 書き出しが数週間止まっていた場合に「残っている全部」を消しかねない。
 */
export async function pruneOldBackups(options: {
  env: AppEnv;
  logger: Logger;
  keep?: number;
}): Promise<number> {
  const bucket = options.env.BACKUPS;
  if (!bucket) return 0;

  const keep = options.keep ?? KEEP_GENERATIONS;
  const listed = await bucket.list({ prefix: "db/" });
  // キーは db/YYYY-MM-DD.json なので、辞書順が日付順になる。
  const keys = listed.objects.map((o) => o.key).sort();
  const doomed = keys.slice(0, Math.max(0, keys.length - keep));

  for (const key of doomed) {
    await bucket.delete(key);
  }
  if (doomed.length > 0) {
    options.logger.info("old backups pruned", { removed: doomed.length });
  }
  return doomed.length;
}
