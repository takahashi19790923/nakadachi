import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emailVerificationTokens, sessions, users } from "~/db/schema/index.ts";
import { emailIndexHmac, otpHash, sha256Hex } from "~/server/crypto.server";
import type { Db } from "~/server/db.server";
import {
  createSession,
  destroySession,
  getSessionUser,
  NO_SESSION_RENEWAL,
  revokeAllSessions,
  SESSION_ABSOLUTE_MAX_SECONDS,
  SESSION_IDLE_SECONDS,
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

  /*
   * ★有効期間は «安全と、送るメールの数» の綱引きになっている。★
   *
   * このサイトは合言葉を持たない（メールでしか入れない）ので、
   * セッションが切れる ＝ ログインコードのメールが1通増える。
   * 2026-08-28 に 30日 → 90日 へ延ばした（Resend の枠を圧迫しないため）。
   *
   * 代わりに、端末を離れた隙に使える時間も90日になる。
   * ★どちらへ動かすときも、意識して動かすこと。★ 気づかずに変わるのを
   * 防ぐために、行の値と Cookie の maxAge の両方をここで固定する。
   * 片方だけ直すと「DB では切れているのにブラウザは送り続ける」
   * （またはその逆）という、原因の分かりにくい状態になる。
   */
  it("★はじめの有効期間は30日（DBとCookieの両方）★", async () => {
    const { userId } = await login("session-ttl@example.test");

    const before = Date.now();
    const { setCookie } = await createSession({ db, env, userId, request: req() });
    const after = Date.now();

    // Cookie 側
    const maxAge = /Max-Age=(\d+)/.exec(setCookie)?.[1];
    expect(maxAge, "Max-Age が付いていること").toBeDefined();
    expect(Number(maxAge)).toBe(SESSION_IDLE_SECONDS);

    // DB 側。作った瞬間からの差で見る（時刻を固定しなくても揺れない）。
    const rows = await db
      .select({ expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.userId, userId));
    const newest = Math.max(...rows.map((r) => r.expiresAt.getTime()));
    expect(newest).toBeGreaterThanOrEqual(before + SESSION_IDLE_SECONDS * 1000);
    expect(newest).toBeLessThanOrEqual(after + SESSION_IDLE_SECONDS * 1000);
  });

  /*
   * ★使うたびに延ばす（sliding expiration）。★
   *
   * このサイトは合言葉を持たないので、セッションが切れる＝ログインコードの
   * メールが1通増える。使っているあいだ切れないようにすると、
   * 毎日使う人の再ログインが実質ゼロになる。
   *
   * ★ここが効かなくなっても、画面はまったく正常に見える。★
   * 利用者が「また入り直しになった」と気づくまで誰にも分からないので、
   * DB・Cookie・上限・書き込み頻度をすべて検査で固定する。
   */
  describe("期限の延長", () => {
    /** 指定した日数ぶん «昔にログインした» 状態を作る */
    async function ageSession(userId: string, daysAgo: number) {
      const created = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
      const expires = new Date(
        created.getTime() + SESSION_IDLE_SECONDS * 1000,
      );
      await db
        .update(sessions)
        .set({ createdAt: created, expiresAt: expires })
        .where(eq(sessions.userId, userId));
      return { created, expires };
    }

    /** renew の呼ばれ方を記録する */
    function spy() {
      const cookies: string[] = [];
      const deferred: Promise<unknown>[] = [];
      return {
        cookies,
        deferred,
        renewal: {
          setCookie: (v: string) => void cookies.push(v),
          defer: (p: Promise<unknown>) => void deferred.push(p),
        },
        async settle() {
          await Promise.all(deferred);
        },
      };
    }

    it("残りが半分を切ったら、DB と Cookie の両方が延びる", async () => {
      const { userId, cookie } = await login("slide@example.test");
      const { expires: was } = await ageSession(userId, 20); // 残り10日

      const s = spy();
      const user = await getSessionUser({
        getDb: () => db,
        env,
        renew: s.renewal,
        request: req({ cookie }),
      });
      expect(user?.id).toBe(userId);
      await s.settle();

      // Cookie 側
      expect(s.cookies).toHaveLength(1);
      const maxAge = Number(/Max-Age=(\d+)/.exec(s.cookies[0]!)?.[1]);
      expect(maxAge).toBe(SESSION_IDLE_SECONDS);

      // DB 側。★片方だけ延びるのがいちばん困る。★
      const [row] = await db
        .select({ expiresAt: sessions.expiresAt })
        .from(sessions)
        .where(eq(sessions.userId, userId));
      expect(row!.expiresAt.getTime()).toBeGreaterThan(was.getTime());
    });

    it("★まだ余裕があるうちは書き込まない★（読むだけの画面に書き込みを乗せない）", async () => {
      const { userId, cookie } = await login("slide-fresh@example.test");
      await ageSession(userId, 5); // 残り25日＝半分より多い

      const s = spy();
      await getSessionUser({
        getDb: () => db,
        env,
        renew: s.renewal,
        request: req({ cookie }),
      });

      expect(s.cookies, "Cookie を出さない").toHaveLength(0);
      expect(s.deferred, "DB を書かない").toHaveLength(0);
    });

    it("★作られてからの上限を超えて延ばさない★", async () => {
      const { userId, cookie } = await login("slide-cap@example.test");

      // 作られてから 360日。上限（365日）まであと5日しかない。
      const created = new Date(Date.now() - 360 * 24 * 60 * 60 * 1000);
      await db
        .update(sessions)
        .set({
          createdAt: created,
          // 残りは1日（＝半分を切っているので延長の対象になる）
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        })
        .where(eq(sessions.userId, userId));

      const s = spy();
      await getSessionUser({
        getDb: () => db,
        env,
        renew: s.renewal,
        request: req({ cookie }),
      });
      await s.settle();

      const cap = created.getTime() + SESSION_ABSOLUTE_MAX_SECONDS * 1000;
      const [row] = await db
        .select({ expiresAt: sessions.expiresAt })
        .from(sessions)
        .where(eq(sessions.userId, userId));

      // 30日ぶん延ばされていたら上限を突破している。
      expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(cap);
      // Cookie も、上限までの残りに合わせて短くなっている。
      const maxAge = Number(/Max-Age=(\d+)/.exec(s.cookies[0]!)?.[1]);
      expect(maxAge).toBeLessThan(SESSION_IDLE_SECONDS);
      expect(maxAge).toBeGreaterThan(0);
    });

    it("上限に達していたら、もう延ばさない（無駄な書き込みもしない）", async () => {
      const { userId, cookie } = await login("slide-maxed@example.test");

      // 作られてから 366日。上限を過ぎているが、期限はまだ1日残っている。
      await db
        .update(sessions)
        .set({
          createdAt: new Date(Date.now() - 366 * 24 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        })
        .where(eq(sessions.userId, userId));

      const s = spy();
      const user = await getSessionUser({
        getDb: () => db,
        env,
        renew: s.renewal,
        request: req({ cookie }),
      });

      // まだ期限内なので入れる。ただし延長はされない。
      expect(user?.id).toBe(userId);
      expect(s.cookies).toHaveLength(0);
      expect(s.deferred).toHaveLength(0);
    });
  });

  it("Cookie からログイン中の利用者を引ける", async () => {
    const { userId, cookie } = await login("session2@example.test");
    const user = await getSessionUser({
      getDb: () => db,
      env,
      renew: NO_SESSION_RENEWAL,
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
      renew: NO_SESSION_RENEWAL,
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
      renew: NO_SESSION_RENEWAL,
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
      renew: NO_SESSION_RENEWAL,
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
