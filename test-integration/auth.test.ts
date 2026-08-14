import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emailVerificationTokens, sessions, users } from "~/db/schema/index.ts";
import { emailIndexHmac, otpHash, sha256Hex } from "~/server/crypto.server";
import type { Db } from "~/server/db.server";
import {
  createSession,
  destroySession,
  getSessionUser,
  revokeAllSessions,
} from "~/server/session.server";
import {
  requestLoginCode,
  verifyLoginOtp,
} from "~/server/services/auth-service.server";
import { closeTestDb, resetDatabase, testEnv, testLogger } from "./helpers.ts";

let db: Db;
const env = testEnv();

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:5273/login", {
    method: "POST",
    headers: { "cf-connecting-ip": "192.0.2.1", ...headers },
  });
}

/**
 * 送信されたメールから OTP を読む。
 *
 * ★DB のハッシュを総当たりして復元しない。★ 以前はそうしていたが、
 *  - 6桁×SHA-256 を最大100万回まわすので、当たりが末尾寄りだと30秒を超えて
 *    テストが落ちる（当たりの位置は毎回変わるので、再現しないフレークになる）
 *  - そもそも「総当たりで戻せる」こと自体が保存方法の欠陥だった
 *    （いまは SESSION_SECRET でHMACしているので戻せない）
 *
 * 代わりに、実際の送信経路を横取りして本文から読む。
 * 送っている中身そのものを見るので、テストとしても強くなる。
 */
const outbox: { subject: string; text: string; html: string }[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith("https://api.resend.com/")) {
      const raw = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(raw) as {
        subject?: string;
        text?: string;
        html?: string;
      };
      outbox.push({
        subject: body.subject ?? "",
        text: body.text ?? "",
        html: body.html ?? "",
      });
      return new Response(JSON.stringify({ id: `test_${outbox.length}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) satisfies typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/** 直近に送られたメールから6桁のコードを取り出す */
function latestOtp(): string {
  const mail = outbox.at(-1);
  if (!mail) throw new Error("メールが送られていません");
  const match = /\b(\d{6})\b/.exec(mail.text);
  if (!match) throw new Error(`本文に6桁のコードがありません: ${mail.subject}`);
  return match[1]!;
}

beforeEach(async () => {
  db = await resetDatabase();
  outbox.length = 0;
});

afterAll(async () => {
  await closeTestDb();
});

describe("ログイン用コードの発行", () => {
  it("★未登録のアドレスでも同じ結果を返す（登録の有無を推測させない）★", async () => {
    const unknown = await requestLoginCode({
      db,
      env,
      logger: testLogger,
      request: req(),
      email: "never-registered@example.test",
    });
    expect(unknown.accepted).toBe(true);

    // トークンは作られている（＝応答も挙動も同じ）
    const emailHmac = await emailIndexHmac(
      env.EMAIL_INDEX_KEY!,
      "never-registered@example.test",
    );
    const rows = await db
      .select({ id: emailVerificationTokens.id })
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.emailHmac, emailHmac));
    expect(rows).toHaveLength(1);
  });

  it("★トークンと OTP を平文で保存しない★", async () => {
    await requestLoginCode({
      db,
      env,
      logger: testLogger,
      request: req(),
      email: "hash-check@example.test",
    });

    const rows = await db.select().from(emailVerificationTokens).limit(1);
    const row = rows[0]!;
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.otpHash).toMatch(/^[0-9a-f]{64}$/);
    // 6桁そのものが入っていないこと
    expect(row.otpHash).not.toMatch(/^\d{6}$/);
  });

  it("★DB が漏れても OTP は総当たりで戻せない（鍵付きハッシュ）★", async () => {
    await requestLoginCode({
      db,
      env,
      logger: testLogger,
      request: req(),
      email: "rainbow@example.test",
    });
    const otp = latestOtp();
    const rows = await db.select().from(emailVerificationTokens).limit(1);
    const stored = rows[0]!.otpHash;

    // 攻撃者が DB だけを手に入れた状況。6桁は100万通りしかないので、
    // 鍵無しの sha256 なら1秒もかからず一致してしまう。
    expect(await sha256Hex(otp)).not.toBe(stored);
    // トークンIDを混ぜているので、鍵を知っていても他のトークンには使い回せない。
    expect(await otpHash(env.SESSION_SECRET!, "別のトークンID", otp)).not.toBe(stored);
    // 正しい鍵とトークンIDなら一致する
    expect(await otpHash(env.SESSION_SECRET!, rows[0]!.id, otp)).toBe(stored);
  });

  it("同じアドレスへ2回発行すると、古いほうは無効になる", async () => {
    for (let i = 0; i < 2; i += 1) {
      await requestLoginCode({
        db,
        env,
        logger: testLogger,
        request: req(),
        email: "reissue@example.test",
      });
    }

    const emailHmac = await emailIndexHmac(env.EMAIL_INDEX_KEY!, "reissue@example.test");
    const active = await db
      .select({ id: emailVerificationTokens.id })
      .from(emailVerificationTokens)
      .where(
        and(
          eq(emailVerificationTokens.emailHmac, emailHmac),
          isNull(emailVerificationTokens.consumedAt),
        ),
      );
    expect(active).toHaveLength(1);
  });

  it("★レート制限がかかる（アドレス単位で5回/10分）★", async () => {
    for (let i = 0; i < 5; i += 1) {
      await requestLoginCode({
        db,
        env,
        logger: testLogger,
        request: req(),
        email: "ratelimited@example.test",
      });
    }
    await expect(
      requestLoginCode({
        db,
        env,
        logger: testLogger,
        request: req(),
        email: "ratelimited@example.test",
      }),
    ).rejects.toThrow();
  });
});

describe("OTP による確認", () => {
  const email = "otp-user@example.test";

  it("初回のログインで利用者が作られる", async () => {
    await requestLoginCode({ db, env, logger: testLogger, request: req(), email });
    const otp = latestOtp();

    const result = await verifyLoginOtp({
      db,
      env,
      logger: testLogger,
      request: req(),
      email,
      otp,
    });

    expect(result.isNewUser).toBe(true);
    expect(result.user.role).toBe("user");

    // ★メールアドレスは暗号化されている★
    const rows = await db.select().from(users).limit(1);
    expect(rows[0]!.emailEncrypted).not.toContain("otp-user");
    expect(rows[0]!.emailHmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("★一度使ったコードは再利用できない★", async () => {
    await requestLoginCode({ db, env, logger: testLogger, request: req(), email });
    const otp = latestOtp();

    await verifyLoginOtp({ db, env, logger: testLogger, request: req(), email, otp });

    await expect(
      verifyLoginOtp({ db, env, logger: testLogger, request: req(), email, otp }),
    ).rejects.toThrow();
  });

  it("違うコードでは通らない", async () => {
    await requestLoginCode({ db, env, logger: testLogger, request: req(), email });
    const otp = latestOtp();
    const wrong = otp === "000000" ? "111111" : "000000";

    await expect(
      verifyLoginOtp({
        db,
        env,
        logger: testLogger,
        request: req(),
        email,
        otp: wrong,
      }),
    ).rejects.toThrow();
  });

  it("★試行回数の上限に達するとトークンごと無効になる★", async () => {
    await requestLoginCode({ db, env, logger: testLogger, request: req(), email });
    const otp = latestOtp();
    const wrong = otp === "000000" ? "111111" : "000000";

    for (let i = 0; i < 5; i += 1) {
      await expect(
        verifyLoginOtp({
          db,
          env,
          logger: testLogger,
          request: req(),
          email,
          otp: wrong,
        }),
      ).rejects.toThrow();
    }

    // 正しいコードでももう通らない
    await expect(
      verifyLoginOtp({ db, env, logger: testLogger, request: req(), email, otp }),
    ).rejects.toThrow();
  });

  it("期限切れのコードは通らない", async () => {
    await requestLoginCode({ db, env, logger: testLogger, request: req(), email });
    const otp = latestOtp();

    await db
      .update(emailVerificationTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) });

    await expect(
      verifyLoginOtp({ db, env, logger: testLogger, request: req(), email, otp }),
    ).rejects.toThrow();
  });
});

describe("セッション", () => {
  async function login(email: string): Promise<{ userId: string; cookie: string }> {
    await requestLoginCode({ db, env, logger: testLogger, request: req(), email });
    const otp = latestOtp();
    const { user } = await verifyLoginOtp({
      db,
      env,
      logger: testLogger,
      request: req(),
      email,
      otp,
    });
    const { setCookie } = await createSession({
      db,
      env,
      userId: user.id,
      request: req(),
    });
    const token = setCookie.split(";")[0]!.split("=")[1]!;
    return { userId: user.id, cookie: `${env.SESSION_COOKIE_NAME}=${token}` };
  }

  it("★セッショントークンを平文で保存しない★", async () => {
    await login("session@example.test");
    const rows = await db.select().from(sessions).limit(1);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("Cookie からログイン中の利用者を引ける", async () => {
    const { userId, cookie } = await login("session2@example.test");
    const user = await getSessionUser({
      getDb: () => db,
      env,
      request: new Request("http://localhost:5273/mypage", { headers: { cookie } }),
    });
    expect(user?.id).toBe(userId);
  });

  it("★ログアウトすると DB 側でも無効になる★", async () => {
    const { cookie } = await login("session3@example.test");
    const request = new Request("http://localhost:5273/logout", {
      method: "POST",
      headers: { cookie },
    });
    await destroySession({ db, env, request });

    const user = await getSessionUser({
      getDb: () => db,
      env,
      request: new Request("http://localhost:5273/mypage", { headers: { cookie } }),
    });
    expect(user).toBeNull();
  });

  it("★停止した利用者はログイン中として扱わない★", async () => {
    const { userId, cookie } = await login("suspended@example.test");
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, userId));

    const user = await getSessionUser({
      getDb: () => db,
      env,
      request: new Request("http://localhost:5273/mypage", { headers: { cookie } }),
    });
    expect(user).toBeNull();
  });

  it("全セッションの失効ができる（停止・返金のときに使う）", async () => {
    const { userId, cookie } = await login("revoke@example.test");
    await revokeAllSessions(db, userId);

    const user = await getSessionUser({
      getDb: () => db,
      env,
      request: new Request("http://localhost:5273/mypage", { headers: { cookie } }),
    });
    expect(user).toBeNull();
  });

  it("★ログインのたびに新しいセッションが作られる（セッション固定攻撃対策）★", async () => {
    const first = await login("fixation@example.test");
    const { setCookie } = await createSession({
      db,
      env,
      userId: first.userId,
      request: req(),
    });
    const secondToken = setCookie.split(";")[0]!.split("=")[1]!;
    expect(secondToken).not.toBe(first.cookie.split("=")[1]);

    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, first.userId));
    expect(rows.length).toBe(2);
  });
});
