import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { accessRecords, emailDeliveryLogs } from "~/db/schema/index.ts";
import { appContext, type AppContext } from "~/server/app-context";
import { csrfCookieName, issueCsrfToken } from "~/server/csrf.server";
import type { Db } from "~/server/db.server";
import { RATE_LIMITS } from "~/server/rate-limit.server";
import { createSession } from "~/server/session.server";
import {
  requestLoginCode,
  verifyLoginLink,
} from "~/server/services/auth-service.server";
import { closeTestDb, makeUser, resetDatabase, testEnv, testLogger } from "./helpers.ts";

import { TURNSTILE_FIELD } from "~/domain/form-fields";
import { sendEmail } from "~/server/services/email/email-service.server";

import { action as rawContactAction } from "~/routes/contact";
import { loader as rawLinkLoader } from "~/routes/login.link";
import { action as rawDeleteAction } from "~/routes/mypage.delete";

/**
 * ログインまわりの守り（監査 PR-C）。
 *
 * ★どれも «理由まで» 見る。★ «何か投げた» だけで緑にすると、別の理由で
 * 止まっていても気づけない（AUTH-06 はまさにそれで、試行の上限に一度も
 * 届いていなかった）。
 */

type RouteFn = (args: {
  request: Request;
  context: RouterContextProvider;
  params: Record<string, string>;
}) => Promise<unknown>;

const deleteAction = rawDeleteAction as unknown as RouteFn;
const linkLoader = rawLinkLoader as unknown as RouteFn;
const contactAction = rawContactAction as unknown as RouteFn;

let db: Db;
const env = testEnv();

/** Resend への送信を横取りして本文を持っておく（実際には送らない） */
const outbox: { subject: string; text: string }[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.resend.com/")) {
      const raw = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(raw) as { subject?: string; text?: string };
      outbox.push({ subject: body.subject ?? "", text: body.text ?? "" });
      return new Response(JSON.stringify({ id: `test_${outbox.length}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // 問い合わせの Turnstile。外へ出さずに «通った» と答える（照合先は testEnv の localhost）。
    if (url.startsWith("https://challenges.cloudflare.com/")) {
      return new Response(JSON.stringify({ success: true, hostname: "localhost" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) satisfies typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await closeTestDb();
});

beforeEach(async () => {
  db = await resetDatabase();
  outbox.length = 0;
});

/** Set-Cookie の行から `名前=値` だけを取り出す */
function cookiePair(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf(";"));
}

/** Worker が組み立てるものと同じ形の context を作る */
function makeContext(csrfToken: string): {
  context: RouterContextProvider;
  deferred: Promise<unknown>[];
} {
  const deferred: Promise<unknown>[] = [];
  const context = new RouterContextProvider();
  const app: AppContext = {
    env,
    ctx: {} as ExecutionContext,
    defer: (promise) => deferred.push(promise.catch(() => undefined)),
    getDb: () => db,
    logger: testLogger,
    nonce: "test-nonce",
    requestId: "test-request",
    setCookie: () => undefined,
    csrfToken,
  };
  context.set(appContext, app);
  return { context, deferred };
}

// ── SEC-12: 退会の申込の回数 ─────────────────────────────────────

describe("★退会の申込は1日3回まで（取り消しは止めない）★", () => {
  async function signIn(userId: string): Promise<string> {
    const { setCookie } = await createSession({
      db,
      env,
      userId,
      request: new Request(env.APP_ORIGIN),
    });
    return cookiePair(setCookie);
  }

  async function post(cookies: string, form: Record<string, string>) {
    const { token, cookieValue } = await issueCsrfToken(env);
    const body = new URLSearchParams({ ...form, _csrf: token });
    const request = new Request(new URL("/mypage/delete", env.APP_ORIGIN), {
      method: "POST",
      headers: {
        origin: env.APP_ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${cookies}; ${csrfCookieName(env)}=${cookieValue}`,
      },
      body,
    });
    const { context, deferred } = makeContext(token);
    const result = (await deleteAction({ request, context, params: {} })) as {
      message: string | null;
      done: boolean;
    };
    await Promise.allSettled(deferred);
    return result;
  }

  async function deletionMails(userId: string): Promise<number> {
    const rows = await db
      .select({ id: emailDeliveryLogs.id })
      .from(emailDeliveryLogs)
      .where(
        and(
          eq(emailDeliveryLogs.template, "account_deletion"),
          eq(emailDeliveryLogs.userId, userId),
        ),
      );
    return rows.length;
  }

  it("申込と取り消しを繰り返しても、メールは3通で止まる", async () => {
    expect(RATE_LIMITS.accountDeletionToggle.max).toBe(3);
    const user = await makeUser(db, "toggle@example.test");
    const cookies = await signIn(user.id);

    for (let i = 0; i < 3; i += 1) {
      const requested = await post(cookies, { confirmation: "退会します" });
      expect(requested, `${i + 1}回目の申込`).toMatchObject({ done: true, message: null });
      const cancelled = await post(cookies, { intent: "cancel" });
      expect(cancelled, `${i + 1}回目の取り消し`).toMatchObject({ done: false, message: null });
    }
    expect(await deletionMails(user.id)).toBe(3);

    // 4回目の申込は回数制限で止まり、メールも出ない。
    const fourth = await post(cookies, { confirmation: "退会します" });
    expect(fourth.done).toBe(false);
    expect(fourth.message).toContain("しばらく時間をおいて");
    expect(await deletionMails(user.id)).toBe(3);

    // ★取り消しは止めない。★ 上限に当たった人も退会を取り消せる。
    const cancelAgain = await post(cookies, { intent: "cancel" });
    expect(cancelAgain).toMatchObject({ done: false, message: null });
  });

  it("確認の文字の打ち間違いでは枠を減らさない", async () => {
    const user = await makeUser(db, "typo@example.test");
    const cookies = await signIn(user.id);

    for (let i = 0; i < 5; i += 1) {
      const typo = await post(cookies, { confirmation: "退会する" });
      expect(typo.done).toBe(false);
      expect(typo.message).toBeNull();
    }
    const real = await post(cookies, { confirmation: "退会します" });
    expect(real).toMatchObject({ done: true, message: null });
  });
});

// ── PRIV-04: リンクでのログインも発信者情報に残す ─────────────────

describe("★メールのリンクでのログイン・登録も発信者情報に残る★", () => {
  /** 直近のメールからリンクのトークンを取り出す */
  function latestLinkToken(): string {
    const mail = outbox.at(-1);
    if (!mail) throw new Error("メールが送られていません");
    const match = /\/login\/link\?token=([A-Za-z0-9_-]+)/.exec(mail.text);
    if (!match) throw new Error(`本文にリンクがありません: ${mail.subject}`);
    return match[1]!;
  }

  async function openLink(token: string): Promise<Response> {
    const request = new Request(
      new URL(`/login/link?token=${token}&next=/mypage`, env.APP_ORIGIN),
      { headers: { "cf-connecting-ip": "198.51.100.7" } },
    );
    const { context } = makeContext("unused");
    try {
      return (await linkLoader({ request, context, params: {} })) as Response;
    } catch (thrown) {
      if (thrown instanceof Response) return thrown;
      throw thrown;
    }
  }

  async function loginEmail(email: string): Promise<string> {
    await requestLoginCode({
      db,
      env,
      logger: testLogger,
      request: new Request(env.APP_ORIGIN, { headers: { "cf-connecting-ip": "198.51.100.7" } }),
      email,
    });
    return latestLinkToken();
  }

  it("新規登録は signup、2回目は login で残る", async () => {
    const first = await openLink(await loginEmail("link@example.test"));
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/mypage");

    const second = await openLink(await loginEmail("link@example.test"));
    expect(second.status).toBe(302);

    const rows = await db
      .select({ action: accessRecords.action, userId: accessRecords.userId })
      .from(accessRecords);
    expect(rows.map((row) => row.action).sort()).toEqual(["login", "signup"]);
    expect(new Set(rows.map((row) => row.userId)).size).toBe(1);
    expect(rows[0]!.userId).not.toBeNull();
  });

  it("失敗したリンクでは残さない", async () => {
    const failed = await openLink("not-a-real-token");
    expect(failed.headers.get("location")).toBe("/login/error?reason=invalid_token");
    const rows = await db.select({ id: accessRecords.id }).from(accessRecords);
    expect(rows).toHaveLength(0);
  });
});

// ── SEC-03: IP が無くても回数制限を飛ばさない ────────────────────

describe("★IP のヘッダが無くても回数制限は効く★", () => {
  /** cf-connecting-ip を付けない要求 */
  function noIp(): Request {
    return new Request(new URL("/login", env.APP_ORIGIN), { method: "POST" });
  }

  it("ログインメールの送信要求: 宛先を変えても IP 単位の上限で止まる", async () => {
    const max = RATE_LIMITS.authRequestByIp.max;
    for (let i = 0; i < max; i += 1) {
      await requestLoginCode({
        db,
        env,
        logger: testLogger,
        request: noIp(),
        email: `spread-${i}@example.test`,
      });
    }
    await expect(
      requestLoginCode({
        db,
        env,
        logger: testLogger,
        request: noIp(),
        email: `spread-${max}@example.test`,
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("問い合わせ: IP 単位の上限で止まる", async () => {
    async function send(n: number) {
      const { token, cookieValue } = await issueCsrfToken(env);
      const body = new URLSearchParams({
        _csrf: token,
        email: `asker-${n}@example.test`,
        subject: `件名 ${n}`,
        body: "お問い合わせの本文です。十文字以上あります。",
        [TURNSTILE_FIELD]: "test-turnstile-token",
      });
      const request = new Request(new URL("/contact", env.APP_ORIGIN), {
        method: "POST",
        headers: {
          origin: env.APP_ORIGIN,
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${csrfCookieName(env)}=${cookieValue}`,
        },
        body,
      });
      const { context, deferred } = makeContext(token);
      const result = (await contactAction({ request, context, params: {} })) as {
        message: string | null;
        sent: boolean;
      };
      await Promise.allSettled(deferred);
      return result;
    }

    const max = RATE_LIMITS.contactSend.max;
    for (let i = 0; i < max; i += 1) {
      expect(await send(i), `${i + 1}通目`).toMatchObject({ sent: true });
    }
    const over = await send(max);
    expect(over.sent).toBe(false);
    expect(over.message).toContain("しばらく時間をおいて");
    expect(outbox).toHaveLength(max);
  });

  it("リンクの確認: IP 単位の上限で止まる", async () => {
    const max = RATE_LIMITS.authVerifyByIp.max;
    for (let i = 0; i < max; i += 1) {
      await expect(
        verifyLoginLink({ db, env, logger: testLogger, request: noIp(), token: `bad-${i}` }),
      ).rejects.toMatchObject({ code: "validation_failed" });
    }
    await expect(
      verifyLoginLink({ db, env, logger: testLogger, request: noIp(), token: "bad-last" }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });
});

// ── SEC-05: 件名は送信の出口で1行になる ──────────────────────────

describe("★件名の改行は、送信の出口で潰れる★", () => {
  it("sendEmail に改行入りの件名を渡しても、送る件名は1行", async () => {
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    const result = await sendEmail(
      {
        template: "contact_inbound",
        to: "support@example.test",
        content: {
          subject: `件名${CR}${LF}Bcc: evil@example.test`,
          html: "<p>本文</p>",
          text: "本文",
        },
        idempotencyKey: "subject-exit-test",
      },
      { db, env, logger: testLogger },
    );
    expect(result.sent).toBe(true);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.subject).toBe("件名 Bcc: evil@example.test");
  });
});
