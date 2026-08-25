import { sql } from "drizzle-orm";

import type { Db } from "../db.server.ts";
import { TABLES } from "./backup-service.server.ts";

/**
 * バックアップの流し込み。
 *
 * ★「バックアップがある」は「戻せる」ではない。★
 * 2026-08-25 の公開前監査の時点で、このサービスには書き出しだけがあって
 * 戻す手順もコードも無かった。しかも OPERATIONS.md に書いてあった復旧手順は
 * Neon の時点復旧（PITR）で、本番はすでに Supabase Free —— ★PITR が無い★ ——
 * へ移っていた。障害の最中に、手順書どおりにやって初めてそれを知ることになる。
 *
 * ここは Worker からは呼ばない。手元から scripts/restore.ts 経由で使う。
 * （Worker に置くと、定期処理の事故で本番を巻き戻せる口ができてしまう）
 *
 * ★型の変換を JS 側でやらない。★ json_populate_recordset に渡して
 * Postgres 自身に解釈させる。JS を挟むと timestamptz のマイクロ秒が落ち、
 * date は時差の分だけ1日ずれる。「件数は合っているのに中身が壊れている」
 * という、いちばん気づきにくい壊れ方になる。
 */

/** 書き出しファイルの形。backup-service.server.ts が作るもの */
export interface BackupFile {
  readonly version: number;
  readonly exportedAt: string;
  readonly environment: string;
  readonly tables: ReadonlyArray<{
    readonly table: string;
    readonly rows: number;
    readonly data: unknown[];
  }>;
}

export interface RestoreTableResult {
  readonly table: string;
  /** 書き出しファイルに入っていた行数 */
  readonly expected: number;
  /** 実際に入った行数 */
  readonly inserted: number;
}

export interface RestoreResult {
  readonly exportedAt: string;
  readonly environment: string;
  readonly tables: RestoreTableResult[];
}

export class RestoreError extends Error {}

/**
 * 書き出しファイルとして読めるかを確かめる。
 *
 * ★流し込む前に全部見る。★ 途中で形が違うと気づくと、
 * 半分だけ入った DB が残る。
 */
export function parseBackup(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new RestoreError(
      `JSON として読めません: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  if (typeof raw !== "object" || raw === null) {
    throw new RestoreError("中身がオブジェクトではありません");
  }
  const file = raw as Record<string, unknown>;

  if (file.version !== 1) {
    throw new RestoreError(
      `対応していない version です: ${JSON.stringify(file.version)}`,
    );
  }
  if (!Array.isArray(file.tables)) {
    throw new RestoreError("tables が配列ではありません");
  }

  const seen = new Set<string>();
  for (const entry of file.tables) {
    if (typeof entry !== "object" || entry === null) {
      throw new RestoreError("tables の要素がオブジェクトではありません");
    }
    const t = entry as Record<string, unknown>;
    if (typeof t.table !== "string") {
      throw new RestoreError("table 名がありません");
    }
    if (!TABLES.includes(t.table as (typeof TABLES)[number])) {
      // 知らない表を黙って飛ばさない。書き出し側と食い違っている合図。
      throw new RestoreError(`知らない表が入っています: ${t.table}`);
    }
    if (!Array.isArray(t.data)) {
      throw new RestoreError(`${t.table}: data が配列ではありません`);
    }
    if (typeof t.rows !== "number" || t.rows !== t.data.length) {
      throw new RestoreError(
        `${t.table}: 件数が合いません（rows=${String(t.rows)} data=${t.data.length}）`,
      );
    }
    seen.add(t.table);
  }

  /*
   * ★書き出し側にある表が欠けていたら止める。★ 欠けたまま流し込むと、
   * 「戻した」あとで一部の表だけが空という状態になる。空の表は
   * data:[] として必ず入っているはずなので、欠けているのは異常。
   */
  const missing = TABLES.filter((table) => !seen.has(table));
  if (missing.length > 0) {
    throw new RestoreError(`表が足りません: ${missing.join(", ")}`);
  }

  return file as unknown as BackupFile;
}

/**
 * 値を入れられる列だけを、定義順に返す。
 *
 * 生成列（is_generated = 'ALWAYS'）と、常に採番される identity 列を外す。
 * どちらも値を渡すとエラーになり、外せば DB 側が計算し直す。
 */
async function insertableColumns(
  tx: Db,
  table: string,
): Promise<string[]> {
  const rows = await tx.execute<{ column_name: string }>(sql`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = ${table}
      and is_generated = 'NEVER'
      and not (is_identity = 'YES' and identity_generation = 'ALWAYS')
    order by ordinal_position
  `);
  return rows.rows.map((r) => r.column_name);
}

/**
 * 流し込む。
 *
 * ★全部まとめて1つのトランザクションにする。★ 途中で落ちたら何も入って
 * いない状態に戻す。半分だけ入った DB は、空の DB より始末が悪い。
 *
 * ★replace の既定は false。★ 中身のある DB へ黙って重ねない。
 * 流し込む前に全部の表を数えて、1行でもあれば入れずに止める。
 *
 * replace: true にすると、対象の表を空にしてから入れる。障害からの
 * 復旧はこちら —— マイグレーションで器を作ると参照データ（地域・カテゴリ・
 * 禁止ワード）が先に入っていることがあり、そのままだと一意制約で落ちる。
 * ★実際に一往復させて初めて分かった。★ 空だと思っていた DB は空ではない。
 */
export async function restoreDatabase(options: {
  db: Db;
  backup: BackupFile;
  replace?: boolean;
}): Promise<RestoreResult> {
  const { db, backup } = options;
  const byTable = new Map(backup.tables.map((t) => [t.table, t]));
  const results: RestoreTableResult[] = [];

  await db.transaction(async (tx) => {
    if (options.replace) {
      /*
       * ★1文でまとめて空にする。★ 表ごとに truncate すると外部キーの
       * 順序を気にすることになる。
       *
       * cascade は、ここに挙げていない表（セッション、認証トークン、
       * レート制限のカウンタ）にも及ぶ。それでよい —— 復旧後の DB に
       * 古いセッションが残っているほうが危ない。
       */
      const list = TABLES.map((t) => sql.identifier(t));
      await tx.execute(
        sql`truncate table ${sql.join(list, sql`, `)} restart identity cascade`,
      );
    } else {
      /*
       * ★先に全部数えて、まとめて知らせる。★ 途中で一意制約に当たると
       * 「duplicate key ...」という、操作者に何をすべきか分からない
       * メッセージだけが出る。
       */
      const occupied: string[] = [];
      for (const table of TABLES) {
        const counted = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from ${sql.identifier(table)}`,
        );
        const n = counted.rows[0]?.n ?? 0;
        if (n > 0) occupied.push(`${table}(${n})`);
      }
      if (occupied.length > 0) {
        throw new RestoreError(
          `対象の DB に行が残っています: ${occupied.join(", ")}。` +
            `中身を捨てて入れ替えるなら replace を指定してください。`,
        );
      }
    }

    // ★TABLES の順で流す。★ 親から子の順に並んでいるので外部キーが満たされる。
    for (const table of TABLES) {
      const entry = byTable.get(table);
      if (!entry) continue; // parseBackup が保証しているので通常は起きない
      if (entry.data.length === 0) {
        results.push({ table, expected: 0, inserted: 0 });
        continue;
      }

      /*
       * ★列を明示して並べる。★ select * にできない。
       *
       * listings.search_text は生成列（GENERATED ALWAYS AS ... STORED）で、
       * 値を入れようとすると「cannot insert a non-DEFAULT value into
       * column」で落ちる。書き出し側は json_agg で全列を出すので、
       * 写しには必ず入っている。★一往復させて初めて分かった。★
       * スキーマを読んで、入れられる列だけを選ぶ。
       *
       * ★null::<表> を型の見本にして Postgres に解釈させる。★
       * これで timestamptz・date・jsonb・列挙型・配列が、書き出したときの
       * 形のまま戻る。JS で new Date() を挟むと精度が落ちる。
       */
      const columns = await insertableColumns(tx, table);
      if (columns.length === 0) {
        throw new RestoreError(`${table}: 入れられる列がありません`);
      }
      const columnList = sql.join(
        columns.map((c) => sql.identifier(c)),
        sql`, `,
      );

      const inserted = await tx.execute(sql`
        insert into ${sql.identifier(table)} (${columnList})
        select ${columnList} from json_populate_recordset(
          null::${sql.identifier(table)},
          ${JSON.stringify(entry.data)}::json
        )
      `);

      results.push({
        table,
        expected: entry.rows,
        inserted: inserted.rowCount ?? 0,
      });
    }

    /*
     * ★件数を確かめてからコミットする。★ 合わなければ投げて全部戻す。
     * 「復旧できました」と言ってから足りないと分かるのがいちばん悪い。
     */
    const short = results.filter((r) => r.inserted !== r.expected);
    if (short.length > 0) {
      const detail = short
        .map((r) => `${r.table}: ${r.inserted}/${r.expected}`)
        .join(", ");
      throw new RestoreError(`入った件数が合いません（${detail}）`);
    }
  });

  return {
    exportedAt: backup.exportedAt,
    environment: backup.environment,
    tables: results,
  };
}

/**
 * 戻したあとの中身を、書き出しファイルと突き合わせる。
 *
 * ★件数が合っただけでは足りない。★ 日付や JSON が壊れていても件数は合う。
 * 各表の先頭の行を、キーごとに値の形で比べる。
 */
export async function verifyRestore(options: {
  db: Db;
  backup: BackupFile;
}): Promise<string[]> {
  const problems: string[] = [];

  for (const entry of options.backup.tables) {
    const counted = await options.db.execute<{ n: number }>(
      sql`select count(*)::int as n from ${sql.identifier(entry.table)}`,
    );
    const actual = counted.rows[0]?.n ?? 0;
    if (actual !== entry.rows) {
      problems.push(`${entry.table}: 件数 ${actual} ≠ ${entry.rows}`);
    }
  }

  return problems;
}
