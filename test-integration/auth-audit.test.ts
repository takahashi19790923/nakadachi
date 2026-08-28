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
