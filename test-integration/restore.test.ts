import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "~/server/db.server";
import { exportDatabase } from "~/server/services/backup-service.server";
import {
  parseBackup,
  restoreDatabase,
  RestoreError,
  verifyRestore,
} from "~/server/services/restore-service.server";

import {
  closeTestDb,
  makeDraft,
  makeUser,
  resetDatabase,
  testEnv,
  testLogger,
} from "./helpers.ts";

/**
 * 書き出し → 空の DB → 流し込み の一往復。
 *
 * ★これが無い間、バックアップは「あるかどうか分からないもの」だった。★
 * 書き出しの検査（backup.test.ts）は、出したものが JSON として読めることまでしか
 * 見ていない。読めることと、戻せることは別。
 *
 * ここで確かめるのは3つ。
 *  1. 戻せること（外部キーの順序、列の対応）
 *  2. 件数が一致すること
 *  3. ★値が壊れていないこと★ —— 日時のマイクロ秒、date のずれ、
 *     jsonb、列挙型。件数だけ見ていると、ここが壊れても気づけない。
 */
let db: Db;

function fakeBucket() {
  const objects = new Map<string, string>();
  return {
    objects,
    put(key: string, body: string) {
      objects.set(key, body);
      return Promise.resolve();
    },
    list() {
      return Promise.resolve({ objects: [...objects.keys()].map((key) => ({ key })) });
    },
    delete(key: string) {
      objects.delete(key);
      return Promise.resolve();
    },
  };
}

/** 書き出して、その本文を返す */
async function exportToString(): Promise<string> {
  const bucket = fakeBucket();
  const env = { ...testEnv(), BACKUPS: bucket as unknown as R2Bucket };
  const result = await exportDatabase({ db, env, logger: testLogger });
  const body = bucket.objects.get(result.key);
  if (!body) throw new Error("書き出しが見つかりません");
  return body;
}

describe("バックアップの流し込み", () => {
  beforeEach(async () => {
    db = await resetDatabase();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("書き出したものを空の DB へ戻せる（件数と中身の両方）", async () => {
    // ── 材料を作る ────────────────────────────────────────────
    const seller = await makeUser(db, "restore-seller@example.com");
    const buyer = await makeUser(db, "restore-buyer@example.com");
    await makeDraft(db, seller.id);
    await makeDraft(db, buyer.id);

    // 日時の精度が落ちていないかを見るための、端数のある時刻。
    await db.execute(sql`
      update users set created_at = timestamptz '2026-03-01 12:34:56.123456+09'
      where id = ${seller.id}
    `);

    const before = await snapshot();
    const body = await exportToString();
    const backup = parseBackup(body);

    // ── 空の DB を作って流し込む ──────────────────────────────
    db = await resetDatabase();
    const emptyUsers = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from users`,
    );
    expect(emptyUsers.rows[0]?.n).toBe(0);

    const result = await restoreDatabase({ db, backup, replace: true });

    // ── 確かめる ──────────────────────────────────────────────
    expect(await verifyRestore({ db, backup })).toEqual([]);

    const usersRestored = result.tables.find((t) => t.table === "users");
    expect(usersRestored?.inserted).toBe(usersRestored?.expected);
    expect(usersRestored?.inserted).toBeGreaterThan(0);

    const after = await snapshot();

    /*
     * ★件数ではなく値で比べる。★ マイクロ秒が落ちる・date が1日ずれる
     * といった壊れ方は、件数の一致をすり抜ける。
     */
    expect(after).toEqual(before);
  });

  it("戻したあとも書き込める（連番や制約が生きている）", async () => {
    const seller = await makeUser(db, "restore-writeback@example.com");
    await makeDraft(db, seller.id);
    const backup = parseBackup(await exportToString());

    db = await resetDatabase();
    await restoreDatabase({ db, backup, replace: true });

    /*
     * ★読めるだけで «戻った» と言わない。★ 戻した直後の DB へ
     * 実際に新しい行を入れてみる。ここが通らないと、復旧の後で
     * 利用者が何もできない状態になる。
     */
    const fresh = await makeUser(db, "restore-after@example.com");
    expect(fresh.id).toBeTruthy();
    await makeDraft(db, fresh.id);
  });

  it("壊れた書き出しは流し込む前に止まる", () => {
    expect(() => parseBackup("{")).toThrow(RestoreError);
    expect(() => parseBackup(`{"version":2,"tables":[]}`)).toThrow(
      /version/,
    );
    // 表が足りない
    expect(() => parseBackup(`{"version":1,"tables":[]}`)).toThrow(
      /表が足りません/,
    );
    // 申告した件数と中身が食い違う
    const wrong = `{"version":1,"exportedAt":"x","environment":"test","tables":[{"table":"users","rows":3,"data":[]}]}`;
    expect(() => parseBackup(wrong)).toThrow(/件数が合いません/);
    // 知らない表
    const unknown = `{"version":1,"exportedAt":"x","environment":"test","tables":[{"table":"secrets","rows":0,"data":[]}]}`;
    expect(() => parseBackup(unknown)).toThrow(/知らない表/);
  });

  it("行が残っている DB へ流し込もうとすると、何も入れずに止まる", async () => {
    const seller = await makeUser(db, "restore-conflict@example.com");
    await makeDraft(db, seller.id);
    const backup = parseBackup(await exportToString());

    // 空にせずそのまま流し込む。既定（replace なし）は入れずに止まる。
    await expect(restoreDatabase({ db, backup })).rejects.toThrow(
      /行が残っています/,
    );

    /*
     * ★失敗しても中身が増えていないこと。★ トランザクションで
     * 巻き戻る作りになっているかを、実際に数えて確かめる。
     */
    const users = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from users`,
    );
    expect(users.rows[0]?.n).toBe(1);
  });
});

/**
 * 中身の写し。件数ではなく値そのものを取る。
 *
 * 並び順は行そのものの文字列表現で決める。★主キーの列名を仮定しない。★
 * user_profiles のように id を持たない表がある（最初これで落ちた）。
 */
async function snapshot(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const table of ["users", "user_profiles", "listings", "categories"]) {
    const rows = await db.execute<{ data: string }>(sql`
      select coalesce(json_agg(t order by t::text)::text, '[]') as data
      from ${sql.identifier(table)} t
    `);
    out[table] = JSON.parse(rows.rows[0]?.data ?? "[]");
  }
  return out;
}
