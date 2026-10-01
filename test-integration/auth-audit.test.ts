import { like, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { auditLogs } from "~/db/schema/index.ts";
import type { Db } from "~/server/db.server";
import { purgeOldAuthAuditLogs } from "~/server/services/retention-service.server";
import {
  requestLoginCode,
  verifyLoginOtp,
} from "~/server/services/auth-service.server";

import { closeTestDb, resetDatabase, testEnv, testLogger } from "./helpers.ts";

/**
 * ログインの成功・失敗の記録。
 *
 * ★2026-08-28 まで、どちらも一切残っていなかった。★
 * 「コードを送った」だけがあり、その先で通ったのか弾かれたのかは
 * 分からない。総当たりを受けても「どのアドレスが・どこから・何回」を
 * 後からたどれなかった（ASVS 5.0 L2 の要求項目）。
 *
 * ★成功だけでも失敗だけでも意味が薄い。★ 両方あって初めて
 * 「10回失敗したあと1回成功した」＝乗っ取られた、が読める。
 */
let db: Db;
const env = testEnv();

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:5273/login", {
    method: "POST",
    headers: { "cf-connecting-ip": "192.0.2.1", ...headers },
  });
}


async function actions(prefix: string): Promise<string[]> {
  const rows = await db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(like(auditLogs.action, `${prefix}%`));
  return rows.map((r) => r.action);
}

describe("ログインの監査記録", () => {
  beforeEach(async () => {
    db = await resetDatabase();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("★失敗が残る（コードが違う）★", async () => {
    const email = "audit-fail@example.test";
    await requestLoginCode({ db, env, logger: testLogger, request: req(), email });

    await expect(
      verifyLoginOtp({
        db,
        env,
        logger: testLogger,
        request: req(),
        email,
        otp: "000000",
      }),
    ).rejects.toThrow();

    expect(await actions("auth.login_failed")).toContain("auth.login_failed");
  });

  it("★失敗が残る（そもそもコードを送っていない）★", async () => {
    await expect(
      verifyLoginOtp({
        db,
        env,
        logger: testLogger,
        request: req(),
        email: "never-asked@example.test",
        otp: "123456",
      }),
    ).rejects.toThrow();

    expect(await actions("auth.login_failed")).toHaveLength(1);
  });

  /*
   * ★成功の検査は auth.test.ts にある。★ あちらは送信を横取りして
   * 本物の OTP を読めるので、実際に «通る» 経路を通せる。
   * ここで «成功したことにする» 検査を置くと、飾りが1つ増えるだけになる。
   */

  it("アドレスそのものを記録に残さない", async () => {
    const email = "leak-check@example.test";
    await requestLoginCode({ db, env, logger: testLogger, request: req(), email });
    await expect(
      verifyLoginOtp({ db, env, logger: testLogger, request: req(), email, otp: "111111" }),
    ).rejects.toThrow();

    const rows = await db.select().from(auditLogs);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(email);
    expect(dump).not.toContain("leak-check");
  });

  it("接続元は生では残さない（ハッシュ化されている）", async () => {
    await expect(
      verifyLoginOtp({
        db,
        env,
        logger: testLogger,
        request: req(),
        email: "ip-check@example.test",
        otp: "222222",
      }),
    ).rejects.toThrow();

    const rows = await db.select().from(auditLogs);
    expect(JSON.stringify(rows)).not.toContain("192.0.2.1");
    const withIp = rows.filter((r) => r.ipHash !== null);
    expect(withIp.length).toBeGreaterThan(0);
    expect(withIp[0]!.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("認証まわりの監査ログの保持期間", () => {
  beforeEach(async () => {
    db = await resetDatabase();
  });

  async function insert(action: string, daysAgo: number) {
    await db.execute(sql`
      insert into audit_logs (id, action, created_at)
      values (${`${action}-${daysAgo}-${Math.trunc(daysAgo * 7919) % 100000}`.slice(0, 26).padEnd(26, "0")},
              ${action},
              now() - make_interval(days => ${daysAgo}))
    `);
  }

  it("★auth.* / authz.* だけを消す。管理操作と決済は残す★", async () => {
    await insert("auth.login_failed", 200);
    await insert("authz.denied", 200);
    await insert("admin.listing_suspend", 200);
    await insert("payment.succeeded", 200);
    await insert("account.purged", 200);

    const removed = await purgeOldAuthAuditLogs(db);
    expect(removed).toBe(2);

    const left = (await db.select({ action: auditLogs.action }).from(auditLogs))
      .map((r) => r.action)
      .sort();
    expect(left).toEqual([
      "account.purged",
      "admin.listing_suspend",
      "payment.succeeded",
    ]);
  });

  /*
   * ★本番と同じ権限で回す。★
   *
   * 上の検査は所有者の権限で回っていたので、本番で起きていたことを
   * 一度も再現していなかった。本番のアプリ用ロールは db:harden で
   * audit_logs の DELETE を取り上げてあり、直接 delete していた掃除は
   * 2026-08-28 から毎日権限エラーで落ちていた（警報が35日続いた）。
   */
  async function asHardenedAppRole<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    await db.execute(sql`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'test_hardened_app') then
          create role test_hardened_app;
        end if;
      end $$
    `);
    await db.execute(sql`grant usage on schema public to test_hardened_app`);
    await db.execute(sql`grant select, insert on audit_logs to test_hardened_app`);
    // db:harden と同じ取り上げ方
    await db.execute(sql`revoke delete, update, truncate on audit_logs from test_hardened_app`);
    // 移行 0009 が本番のアプリ用ロールへ渡すのと同じ実行権
    await db.execute(sql`grant execute on function public.purge_auth_audit_logs(integer) to test_hardened_app`);

    return db.transaction(async (tx) => {
      await tx.execute(sql`set local role test_hardened_app`);
      return fn(tx);
    });
  }

  it("（前提の確認）このロールでは audit_logs を直接消せない", async () => {
    // ★これが通らないなら、下の検査は本番を再現していない。★
    await insert("auth.login_failed", 200);
    await expect(
      asHardenedAppRole((tx) => tx.execute(sql`delete from audit_logs`)),
    ).rejects.toMatchObject({ cause: { code: "42501" } }); // permission denied
  });

  it("★DELETE を取り上げたロールでも、古い auth 系だけを消せる★", async () => {
    await insert("auth.login_failed", 200);
    await insert("authz.denied", 200);
    await insert("auth.login_failed", 10);
    await insert("admin.listing_suspend", 400);

    const removed = await asHardenedAppRole((tx) => purgeOldAuthAuditLogs(tx));
    expect(removed).toBe(2);

    const left = (await db.select({ action: auditLogs.action }).from(auditLogs))
      .map((r) => r.action)
      .sort();
    expect(left).toEqual(["admin.listing_suspend", "auth.login_failed"]);
  });

  it("★180日より短くは消させない（関数の中で固定）★", async () => {
    // 引数で縮められると、乗っ取った相手が直近の記録を消せる。
    await insert("auth.login_failed", 10);
    await expect(
      asHardenedAppRole((tx) =>
        tx.execute(sql`select public.purge_auth_audit_logs(0)`),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining("at least 180") } });
    expect(
      await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs),
    ).toEqual([{ n: 1 }]);
  });

  it("期限内のものは消さない", async () => {
    await insert("auth.login_failed", 10);
    expect(await purgeOldAuthAuditLogs(db)).toBe(0);
    expect(
      await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs),
    ).toEqual([{ n: 1 }]);
  });
});

/**
 * 未ログインの相手に DB を触らせない。
 *
 * ★これは「性能の話」ではなく「設計の前提」。★
 * getSessionUser は Cookie が無ければ接続を作らずに戻る。公開ページを
 * 見ているだけの人に接続を張らないため、そして DATABASE_URL が無い環境
 * （E2E など）でも規約ページが出るようにするため。
 *
 * 2026-08-28、authz.denied を無条件に書くようにしたら、
 * ★/admin を叩くだけで誰でも DB 接続を作らせられる★状態になり、
 * DB を持たない E2E で /admin が 404 ではなく 500 になった。
 * 「記録を増やす」変更が、記録と関係のない前提を壊した例。
 */
describe("未ログインの /admin", () => {
  beforeEach(async () => {
    db = await resetDatabase();
  });

  it("★DB を1度も触らずに 404 になる★", async () => {
    const { requireAdmin } = await import("~/server/guards.server");

    let dbTouched = false;
    const context = {
      env,
      getDb: () => {
        dbTouched = true;
        return db;
      },
      defer: () => undefined,
      setCookie: () => undefined,
      logger: testLogger,
      nonce: "n",
      requestId: "r",
      csrfToken: "c",
      ctx: {} as ExecutionContext,
    };

    const request = new Request("http://localhost:5273/admin");
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requireAdmin({ request, context: context as any }),
    ).rejects.toBeInstanceOf(Response);

    expect(dbTouched, "未ログインでは DB に触らないこと").toBe(false);
  });

  it("ログイン済みで管理者でなければ、記録は残る", async () => {
    const { requireAdmin } = await import("~/server/guards.server");
    const { makeUser } = await import("./helpers.ts");
    const { createSession } = await import("~/server/session.server");

    const user = await makeUser(db, "not-admin@example.test");
    const { setCookie } = await createSession({
      db,
      env,
      userId: user.id,
      request: req(),
    });
    const token = setCookie.split(";")[0]!.split("=")[1]!;

    const context = {
      env,
      getDb: () => db,
      defer: () => undefined,
      setCookie: () => undefined,
      logger: testLogger,
      nonce: "n",
      requestId: "r",
      csrfToken: "c",
      ctx: {} as ExecutionContext,
    };
    const request = new Request("http://localhost:5273/admin/users", {
      headers: { cookie: `${env.SESSION_COOKIE_NAME}=${token}` },
    });

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requireAdmin({ request, context: context as any }),
    ).rejects.toBeInstanceOf(Response);

    expect(await actions("authz.denied")).toEqual(["authz.denied"]);
  });
});
