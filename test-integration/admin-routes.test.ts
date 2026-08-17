import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { adminActions, auditLogs, listings, reports, sessions, users } from "~/db/schema/index.ts";
import { ulid } from "~/domain/ulid";
import { issueGateCookie } from "~/server/admin-gate.server";
import { appContext, type AppContext } from "~/server/app-context";
import { csrfCookieName, issueCsrfToken } from "~/server/csrf.server";
import type { Db } from "~/server/db.server";
import { getPublishedListing, searchListings } from "~/server/repositories/listing-repository.server";
import { createReport } from "~/server/repositories/moderation-repository.server";
import { createSession, getSessionUser } from "~/server/session.server";
import {
  closeTestDb,
  makeDraft,
  makeUser,
  resetDatabase,
  testEnv,
  testLogger,
} from "./helpers.ts";

import { action as rawListingAction } from "~/routes/admin.listing-detail";
import { action as rawReportAction } from "~/routes/admin.reports";
import { action as rawUserAction } from "~/routes/admin.users";

/**
 * ルートの action をテストから呼ぶための型。
 *
 * 生成される Route.ActionArgs にはルーターしか組み立てられない `matches` が
 * 入っているので、そのままでは呼べない。action が実際に読むのは
 * request / context / params の3つだけなので、その形に読み替える。
 */
type RouteAction = (args: {
  request: Request;
  context: RouterContextProvider;
  params: Record<string, string>;
}) => Promise<unknown>;

const listingAction = rawListingAction as unknown as RouteAction;
const reportAction = rawReportAction as unknown as RouteAction;
const userAction = rawUserAction as unknown as RouteAction;

/**
 * 管理画面の対応操作。
 *
 * ★ここは1度も実際に走らせていなかった経路。★ サービス層の検査はあったが、
 * ルートの action そのもの（フォームの読み取り・CSRF・第3層の通過証・
 * 監査ログ・通知）は誰も通していなかった。管理画面は事故が起きてから
 * 初めて使う。★そのとき初めて壊れていると分かるのでは遅い。★
 *
 * 実際のブラウザではなく action を直接呼ぶが、Worker が組み立てるものと
 * 同じ Request と context を作って渡す。フォームの名前を間違えれば落ちる。
 */
let db: Db;
const env = testEnv();

let admin: { id: string };
let owner: { id: string };
let adminCookies: string;

beforeEach(async () => {
  db = await resetDatabase();
  admin = await makeUser(db, "admin@example.test", "admin");
  owner = await makeUser(db, "owner@example.test");
  adminCookies = await signInAsAdmin(admin.id);
});

afterAll(async () => {
  await closeTestDb();
});

/** Set-Cookie の行から `名前=値` だけを取り出す */
function cookiePair(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf(";"));
}

/**
 * 第1層（ログイン）と第3層（共通の資格情報）を通した状態の Cookie を作る。
 * 第2層（管理者の再認証）は通過証が同じ Cookie に乗るため、ここでは
 * 第3層の通過証だけで足りる。
 */
async function signInAsAdmin(userId: string): Promise<string> {
  const { setCookie } = await createSession({
    db,
    env,
    userId,
    request: new Request(env.APP_ORIGIN),
  });
  const gate = await issueGateCookie(env);
  return `${cookiePair(setCookie)}; ${cookiePair(gate)}`;
}

interface CallOptions {
  path: string;
  form: Record<string, string>;
  params?: Record<string, string>;
  /** 差し替えたいとき。既定は管理者としてログイン済み・第3層通過済み */
  cookies?: string;
  /** CSRF を意図的に壊すため */
  omitCsrf?: boolean;
  /** 別サイトからの送信を模すため */
  origin?: string;
}

/** Worker が組み立てるものと同じ形の Request と context を作って action を呼ぶ */
async function callAction(action: RouteAction, options: CallOptions) {
  const { token, cookieValue } = await issueCsrfToken(env);
  const cookies = options.cookies ?? adminCookies;
  const body = new URLSearchParams(options.form);
  if (!options.omitCsrf) body.set("_csrf", token);

  const request = new Request(new URL(options.path, env.APP_ORIGIN), {
    method: "POST",
    headers: {
      origin: options.origin ?? env.APP_ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${cookies}; ${csrfCookieName(env)}=${cookieValue}`,
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
    csrfToken: token,
  };
  context.set(appContext, app);

  const result = await action({
    request,
    context,
    params: options.params ?? {},
  });
  // 応答後の処理（通知メールなど）も終わらせてから返す。
  await Promise.allSettled(deferred);
  return result as { message?: string | null; fields?: Record<string, string> | null };
}

async function makePublished(ownerId: string): Promise<string> {
  return makeDraft(db, ownerId, {
    status: "published",
    publishedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
  });
}

// ── 投稿の非公開化 ────────────────────────────────────────────────

describe("★投稿を非公開にする★", () => {
  it("非公開にすると公開ページから消え、監査ログが残る", async () => {
    const listingId = await makePublished(owner.id);
    expect(await getPublishedListing(db, listingId)).not.toBeNull();

    const result = await callAction(listingAction, {
      path: `/admin/listings/${listingId}`,
      params: { listingId },
      form: { intent: "suspend", reason: "禁止されている出品のため" },
    });

    expect(result.message).toBeNull();
    expect(await getPublishedListing(db, listingId)).toBeNull();

    const [row] = await db
      .select({ status: listings.status, reason: listings.moderationReason })
      .from(listings)
      .where(eq(listings.id, listingId));
    expect(row!.status).toBe("suspended");
    expect(row!.reason).toBe("禁止されている出品のため");

    // ★理由つきで両方の記録に残ること。★ あとから判断の当否を検証できるように。
    const actions = await db
      .select({ type: adminActions.actionType, reason: adminActions.reason })
      .from(adminActions);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("listing_suspend");
    expect(actions[0]!.reason).toBe("禁止されている出品のため");

    const audit = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.action, "admin.listing_suspended"));
    expect(audit).toHaveLength(1);
  });

  it("非公開にしたものを公開に戻せる", async () => {
    const listingId = await makePublished(owner.id);
    await callAction(listingAction, {
      path: `/admin/listings/${listingId}`,
      params: { listingId },
      form: { intent: "suspend", reason: "確認のため一時的に非公開" },
    });

    const result = await callAction(listingAction, {
      path: `/admin/listings/${listingId}`,
      params: { listingId },
      form: { intent: "restore", reason: "確認できたため公開に戻す" },
    });

    expect(result.message).toBeNull();
    expect(await getPublishedListing(db, listingId)).not.toBeNull();
  });

  it("★理由が短いと何も起きない★", async () => {
    const listingId = await makePublished(owner.id);

    const result = await callAction(listingAction, {
      path: `/admin/listings/${listingId}`,
      params: { listingId },
      form: { intent: "suspend", reason: "だめ" },
    });

    expect(result.fields?.reason).toContain("5文字以上");
    expect(await getPublishedListing(db, listingId)).not.toBeNull();
    expect(await db.select().from(adminActions)).toHaveLength(0);
  });

  it("★CSRF トークンが無ければ通らない★", async () => {
    const listingId = await makePublished(owner.id);

    const result = await callAction(listingAction, {
      path: `/admin/listings/${listingId}`,
      params: { listingId },
      form: { intent: "suspend", reason: "本来なら通る理由の文字列" },
      omitCsrf: true,
    });

    expect(result.message).toBeTruthy();
    expect(await getPublishedListing(db, listingId)).not.toBeNull();
  });

  it("★別サイトからの送信は通らない★", async () => {
    const listingId = await makePublished(owner.id);

    const result = await callAction(listingAction, {
      path: `/admin/listings/${listingId}`,
      params: { listingId },
      form: { intent: "suspend", reason: "本来なら通る理由の文字列" },
      origin: "https://evil.example",
    });

    expect(result.message).toBeTruthy();
    expect(await getPublishedListing(db, listingId)).not.toBeNull();
  });

  it("★第3層の通過証が無ければゲートへ送り返される★", async () => {
    const listingId = await makePublished(owner.id);
    const { setCookie } = await createSession({
      db,
      env,
      userId: admin.id,
      request: new Request(env.APP_ORIGIN),
    });

    // ログインはしているが、共通の資格情報を入れていない状態。
    await expect(
      callAction(listingAction, {
        path: `/admin/listings/${listingId}`,
        params: { listingId },
        form: { intent: "suspend", reason: "本来なら通る理由の文字列" },
        cookies: cookiePair(setCookie),
      }),
    ).rejects.toMatchObject({ status: 302 });

    expect(await getPublishedListing(db, listingId)).not.toBeNull();
  });

  it("★管理者でなければ通らない★", async () => {
    const listingId = await makePublished(owner.id);
    const cookies = await signInAsAdmin(owner.id); // 一般利用者

    await expect(
      callAction(listingAction, {
        path: `/admin/listings/${listingId}`,
        params: { listingId },
        form: { intent: "suspend", reason: "本来なら通る理由の文字列" },
        cookies,
      }),
    ).rejects.toBeDefined();

    expect(await getPublishedListing(db, listingId)).not.toBeNull();
  });
});

// ── 利用者の停止 ──────────────────────────────────────────────────

describe("★利用者を停止する★", () => {
  it("停止するとログインが切れ、次から入れない", async () => {
    const cookies = await signInAsAdmin(owner.id);
    const sessionToken = cookies.split("=")[1]!.split(";")[0]!;
    const loggedIn = new Request(env.APP_ORIGIN, {
      headers: { cookie: `${env.SESSION_COOKIE_NAME}=${sessionToken}` },
    });
    expect(
      await getSessionUser({ request: loggedIn, env, getDb: () => db }),
    ).not.toBeNull();

    const result = await callAction(userAction, {
      path: "/admin/users",
      form: { userId: owner.id, intent: "suspend", reason: "詐欺の疑いがあるため" },
    });
    expect(result.message).toBeNull();

    // ★止めても入ったままでは意味がない。★
    expect(
      await getSessionUser({ request: loggedIn, env, getDb: () => db }),
    ).toBeNull();

    // 行は消さず失効印をつける（いつ切られたかを追えるようにするため）。
    const revoked = await db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.userId, owner.id));
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.revokedAt).not.toBeNull();

    const [row] = await db
      .select({ status: users.status, reason: users.suspendedReason })
      .from(users)
      .where(eq(users.id, owner.id));
    expect(row!.status).toBe("suspended");
    expect(row!.reason).toBe("詐欺の疑いがあるため");
  });

  it("★停止した利用者の掲載が公開ページから消える★", async () => {
    /*
     * ★これが利用者停止の目的。★ 詐欺の疑いで止めるのに掲載が出たままなら、
     * 止めた意味がない。本人はログインできないので取り下げることもできず、
     * 問い合わせだけが届き続ける。
     */
    const listingId = await makePublished(owner.id);
    expect(await getPublishedListing(db, listingId)).not.toBeNull();

    await callAction(userAction, {
      path: "/admin/users",
      form: { userId: owner.id, intent: "suspend", reason: "詐欺の疑いがあるため" },
    });

    expect(await getPublishedListing(db, listingId)).toBeNull();

    // 一覧・検索からも消えること（詳細だけ塞いでも意味がない）。
    const found = await searchListings(db, { page: 1, perPage: 20, sort: "newest" });
    expect(found.items.map((item) => item.id)).not.toContain(listingId);
    expect(found.total).toBe(0);
  });

  it("★復帰させると掲載も戻る★", async () => {
    const listingId = await makePublished(owner.id);
    await callAction(userAction, {
      path: "/admin/users",
      form: { userId: owner.id, intent: "suspend", reason: "確認のため一時停止" },
    });
    expect(await getPublishedListing(db, listingId)).toBeNull();

    await callAction(userAction, {
      path: "/admin/users",
      form: { userId: owner.id, intent: "restore", reason: "" },
    });

    expect(await getPublishedListing(db, listingId)).not.toBeNull();
    const [row] = await db
      .select({ status: users.status, reason: users.suspendedReason })
      .from(users)
      .where(eq(users.id, owner.id));
    expect(row!.status).toBe("active");
    expect(row!.reason).toBeNull();
  });

  it("自分自身は停止できない", async () => {
    const result = await callAction(userAction, {
      path: "/admin/users",
      form: { userId: admin.id, intent: "suspend", reason: "自分を止めてみる" },
    });

    expect(result.message).toContain("自分自身");
    const [row] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, admin.id));
    expect(row!.status).toBe("active");
  });

  it("★居ない利用者を止めたことにしない★", async () => {
    /*
     * ULID として正しくても、その利用者が存在するとは限らない。
     * 素通りさせると「停止しました」と表示され、監査ログにも残るのに
     * 誰も止まっていない。★記録が嘘になるのがいちばん困る。★
     */
    const result = await callAction(userAction, {
      path: "/admin/users",
      form: { userId: ulid(), intent: "suspend", reason: "存在しない利用者" },
    });

    expect(result.message).toBeTruthy();
    expect(await db.select().from(adminActions)).toHaveLength(0);
  });
});

// ── 通報の対応 ────────────────────────────────────────────────────

describe("★通報に対応する★", () => {
  async function makeReport(listingId: string): Promise<string> {
    const reporter = await makeUser(db, `reporter-${ulid()}@example.test`);
    await createReport(db, {
      reporterId: reporter.id,
      target: { type: "listing", id: listingId },
      reason: "prohibited_item",
      detail: "禁止されている出品に見えます",
    });
    const [row] = await db
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.targetListingId, listingId));
    return row!.id;
  }

  it("対応済みにすると記録が残る", async () => {
    const listingId = await makePublished(owner.id);
    const reportId = await makeReport(listingId);

    const result = await callAction(reportAction, {
      path: "/admin/reports",
      form: { reportId, status: "actioned", note: "投稿を非公開にしました" },
    });

    expect(result.message).toBeNull();
    const [row] = await db
      .select({
        status: reports.status,
        resolvedBy: reports.resolvedBy,
        note: reports.resolutionNote,
        resolvedAt: reports.resolvedAt,
      })
      .from(reports)
      .where(eq(reports.id, reportId));
    expect(row!.status).toBe("actioned");
    expect(row!.resolvedBy).toBe(admin.id);
    expect(row!.note).toBe("投稿を非公開にしました");
    expect(row!.resolvedAt).not.toBeNull();

    const actions = await db
      .select({ type: adminActions.actionType })
      .from(adminActions);
    expect(actions[0]!.type).toBe("report_resolve");
  });

  it("確認中に戻すと対応日時は空に戻る", async () => {
    const listingId = await makePublished(owner.id);
    const reportId = await makeReport(listingId);

    await callAction(reportAction, {
      path: "/admin/reports",
      form: { reportId, status: "actioned", note: "いったん対応済みにする" },
    });
    await callAction(reportAction, {
      path: "/admin/reports",
      form: { reportId, status: "reviewing", note: "やはり確認中に戻す" },
    });

    const [row] = await db
      .select({ status: reports.status, resolvedAt: reports.resolvedAt })
      .from(reports)
      .where(eq(reports.id, reportId));
    expect(row!.status).toBe("reviewing");
    expect(row!.resolvedAt).toBeNull();
  });

  it("対応の記録が短いと何も起きない", async () => {
    const listingId = await makePublished(owner.id);
    const reportId = await makeReport(listingId);

    const result = await callAction(reportAction, {
      path: "/admin/reports",
      form: { reportId, status: "dismissed", note: "済" },
    });

    expect(result.message).toContain("3文字以上");
    const [row] = await db
      .select({ status: reports.status })
      .from(reports)
      .where(eq(reports.id, reportId));
    expect(row!.status).toBe("open");
  });

  it("★居ない通報を対応済みにしたことにしない★", async () => {
    // 素通りさせると、未対応の通報が残ったまま件数だけが減ったように見える。
    const result = await callAction(reportAction, {
      path: "/admin/reports",
      form: { reportId: ulid(), status: "actioned", note: "存在しない通報" },
    });

    expect(result.message).toBeTruthy();
    expect(await db.select().from(adminActions)).toHaveLength(0);
  });
});
