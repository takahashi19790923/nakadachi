import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminActions, bannedWords, listings, payments, sessions, users } from "~/db/schema/index.ts";
import { LISTING_FEE_JPY } from "~/domain/pricing";
import { ulid } from "~/domain/ulid";
import { issueGateCookie } from "~/server/admin-gate.server";
import { appContext, type AppContext } from "~/server/app-context";
import { csrfCookieName, issueCsrfToken } from "~/server/csrf.server";
import type * as AuditModule from "~/server/audit.server";
import type { Db } from "~/server/db.server";
import { getSiteFlags, setSiteFlags } from "~/server/services/site-flags.server";
import { createSession } from "~/server/session.server";
import { action as rawBannedWordsAction } from "~/routes/admin.banned-words";
import { action as rawFlagsAction } from "~/routes/admin.flags";
import { action as rawListingAction } from "~/routes/admin.listing-detail";
import { action as rawPaymentsAction } from "~/routes/admin.payments";
import { action as rawUserAction } from "~/routes/admin.users";
import { action as rawImagesAction } from "~/routes/listings.images";
import { action as rawReportAction } from "~/routes/listings.report";
import { action as rawProfileAction } from "~/routes/mypage.profile";
import { closeTestDb, makeDraft, makeUser, resetDatabase, testEnv, testLogger } from "./helpers.ts";

/**
 * ルートの action を通した守り（2026-10 の監査 ADM-03・ADM-14・FN-08・AUTHZ-03・SEC-06 と、
 * そのレビューで «検査が固定していない» とされたもの）。
 *
 * ★ADM-03 の巻き戻しは、記録の関数を1回だけ失敗させて確かめる。★
 * DB 側でエラーを起こす（トリガー）と、検査用 DB（PGlite のソケット）との通信が崩れるため。
 */
const control = vi.hoisted(() => ({ failNextAdminAction: false }));

vi.mock("~/server/audit.server", async (importOriginal) => {
  const actual = await importOriginal<typeof AuditModule>();
  return {
    ...actual,
    writeAdminAction: async (...args: Parameters<typeof actual.writeAdminAction>) => {
      if (control.failNextAdminAction) {
        control.failNextAdminAction = false;
        throw new Error("admin action write failed (test)");
      }
      return actual.writeAdminAction(...args);
    },
  };
});

type RouteAction = (args: {
  request: Request;
  context: RouterContextProvider;
  params: Record<string, string>;
}) => Promise<unknown>;

let db: Db;
const env = testEnv();
let admin: { id: string };
let owner: { id: string };
let adminCookies: string;
let ownerCookies: string;

beforeEach(async () => {
  db = await resetDatabase();
  control.failNextAdminAction = false;
  admin = await makeUser(db, "admin-route@example.test", "admin");
  owner = await makeUser(db, "owner-route@example.test");
  adminCookies = `${await sessionCookie(admin.id)}; ${cookiePair(await issueGateCookie(env))}`;
  ownerCookies = await sessionCookie(owner.id);
});

afterEach(async () => {
  // ★運用スイッチを元に戻す。★ 読み取り側は30秒キャッシュするので、戻さないと
  // 後に走る検査ファイルまで «停止中» が残る（setSiteFlags がキャッシュも捨てる）。
  await setSiteFlags(db, admin.id, {
    signupsPaused: false,
    listingsPaused: false,
    messagesPaused: false,
  });
});

afterAll(async () => {
  await closeTestDb();
});

function cookiePair(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf(";"));
}

async function sessionCookie(userId: string): Promise<string> {
  const { setCookie } = await createSession({ db, env, userId, request: new Request(env.APP_ORIGIN) });
  return cookiePair(setCookie);
}

/** Worker が組み立てるものと同じ形の Request と context で action を呼ぶ */
async function callAction(
  action: unknown,
  options: { path: string; form: Record<string, string>; params?: Record<string, string>; cookies: string },
) {
  const { token, cookieValue } = await issueCsrfToken(env);
  const body = new URLSearchParams(options.form);
  body.set("_csrf", token);
  const request = new Request(new URL(options.path, env.APP_ORIGIN), {
    method: "POST",
    headers: {
      origin: env.APP_ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${options.cookies}; ${csrfCookieName(env)}=${cookieValue}`,
    },
    body,
  });
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
    csrfToken: token,
  };
  context.set(appContext, app);
  const result = await (action as RouteAction)({ request, context, params: options.params ?? {} });
  await Promise.allSettled(deferred);
  return result as { message?: string | null; fields?: Record<string, string> | null };
}

async function adminActionCount() {
  return (await db.select({ id: adminActions.id }).from(adminActions)).length;
}

describe("★管理操作の記録が書けなければ、操作も巻き戻す（ADM-03）★", () => {
  it("利用者の停止: 利用者は止まらず、ログイン中の端末も切れない", async () => {
    control.failNextAdminAction = true;
    const result = await callAction(rawUserAction, {
      path: "/admin/users",
      form: { userId: owner.id, intent: "suspend", reason: "記録が書けない場合の検査" },
      cookies: adminCookies,
    });
    expect(result.message).toBeTruthy();
    const [user] = await db.select({ status: users.status }).from(users).where(eq(users.id, owner.id));
    expect(user!.status).toBe("active");
    const live = await db.select({ revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.userId, owner.id));
    expect(live.every((s) => s.revokedAt === null)).toBe(true);
  });

  it("投稿の非公開: 投稿は公開のまま", async () => {
    const listingId = await makeDraft(db, owner.id, {
      status: "published",
      publishedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    control.failNextAdminAction = true;
    const result = await callAction(rawListingAction, {
      path: `/admin/listings/${listingId}`,
      params: { listingId },
      form: { intent: "suspend", reason: "記録が書けない場合の検査" },
      cookies: adminCookies,
    });
    expect(result.message).toBeTruthy();
    const [row] = await db.select({ status: listings.status }).from(listings).where(eq(listings.id, listingId));
    expect(row!.status).toBe("published");
  });

  it("運用スイッチ: 切り替わらない", async () => {
    control.failNextAdminAction = true;
    await callAction(rawFlagsAction, {
      path: "/admin/flags",
      form: { messagesPaused: "on", reason: "記録が書けない場合の検査" },
      cookies: adminCookies,
    });
    expect((await getSiteFlags(db, Date.now() + 60_000)).messagesPaused).toBe(false);
  });

  it("禁止語の追加: 語は登録されない", async () => {
    const before = (await db.select({ id: bannedWords.id }).from(bannedWords)).length;
    control.failNextAdminAction = true;
    await callAction(rawBannedWordsAction, {
      path: "/admin/banned-words",
      form: { intent: "add", word: "検査用の語句", severity: "flag" },
      cookies: adminCookies,
    });
    expect((await db.select({ id: bannedWords.id }).from(bannedWords)).length).toBe(before);
  });
});

describe("管理操作の正常系と «記録＝事実»", () => {
  it("運用スイッチを切り替えると、状態と記録が1件ずつ残る", async () => {
    const result = await callAction(rawFlagsAction, {
      path: "/admin/flags",
      form: { messagesPaused: "on", reason: "検査のための切り替え" },
      cookies: adminCookies,
    });
    expect(result.message ?? null).toBeNull();
    expect((await getSiteFlags(db, Date.now() + 60_000)).messagesPaused).toBe(true);
    expect(await adminActionCount()).toBe(1);
  });

  it("禁止語: 追加で記録1件、同じ語の再追加は記録しない、記号だけの語は弾く（ADM-14）", async () => {
    await callAction(rawBannedWordsAction, {
      path: "/admin/banned-words",
      form: { intent: "add", word: "検査用の語句", severity: "flag" },
      cookies: adminCookies,
    });
    expect(await adminActionCount()).toBe(1);
    const again = await callAction(rawBannedWordsAction, {
      path: "/admin/banned-words",
      form: { intent: "add", word: "検査用の語句", severity: "flag" },
      cookies: adminCookies,
    });
    expect(again.message).toContain("すでに登録");
    expect(await adminActionCount()).toBe(1);
    const symbols = await callAction(rawBannedWordsAction, {
      path: "/admin/banned-words",
      form: { intent: "add", word: "・・", severity: "block" },
      cookies: adminCookies,
    });
    expect(symbols.message).toContain("2文字以上");
    const withBreak = await callAction(rawBannedWordsAction, {
      path: "/admin/banned-words",
      form: { intent: "add", word: "line.me", severity: "block" },
      cookies: adminCookies,
    });
    expect(withBreak.message).toContain("区切り");
    expect(await adminActionCount()).toBe(1);
  });

  it("返金: 無い決済・返金できない決済には記録を残さない", async () => {
    const missing = await callAction(rawPaymentsAction, {
      path: "/admin/payments",
      form: { paymentId: ulid(), reason: "検査のための返金" },
      cookies: adminCookies,
    });
    expect(missing.message).toContain("見つかりませんでした");
    const listingId = await makeDraft(db, owner.id, { status: "draft" });
    const id = ulid();
    await db.insert(payments).values({
      id,
      listingId,
      userId: owner.id,
      provider: "stripe",
      checkoutSessionId: "cs_route_expired",
      amountJpy: LISTING_FEE_JPY,
      currency: "jpy",
      status: "expired",
    });
    const notRefundable = await callAction(rawPaymentsAction, {
      path: "/admin/payments",
      form: { paymentId: id, reason: "検査のための返金" },
      cookies: adminCookies,
    });
    expect(notRefundable.message).toContain("返金できる状態ではありません");
    expect(await adminActionCount()).toBe(0);
  });
});

describe("利用者の操作のゲート", () => {
  it("通報は公開中の投稿だけ（FN-08）: 下書きへの通報は 404", async () => {
    const draftId = await makeDraft(db, admin.id, { status: "draft" });
    const error = await callAction(rawReportAction, {
      path: `/listings/${draftId}/report`,
      params: { listingId: draftId },
      form: { reason: "fraud", detail: "検査のための通報です" },
      cookies: ownerCookies,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Response);
    expect((error as Response).status).toBe(404);
  });

  it("止められた・決済の手続き中の投稿の写真は変えられない（AUTHZ-03）", async () => {
    for (const status of ["suspended", "payment_pending"] as const) {
      const listingId = await makeDraft(db, owner.id, { status });
      const result = await callAction(rawImagesAction, {
        path: `/listings/${listingId}/images`,
        params: { listingId },
        form: { intent: "remove", imageId: ulid() },
        cookies: ownerCookies,
      });
      expect(result.message).toContain("いまは変更できません");
    }
  });

  it("表示名・自己紹介に禁止語があれば保存しない（SEC-06）。欄ごとに印を付ける", async () => {
    const result = await callAction(rawProfileAction, {
      path: "/mypage/profile",
      form: { displayName: "ふつうの名前", bio: "闇バイトの相談に乗ります", prefectureCode: "13" },
      cookies: ownerCookies,
    });
    expect(result.fields?.bio).toBeTruthy();
    expect(result.fields?.displayName).toBeUndefined();
  });
});
