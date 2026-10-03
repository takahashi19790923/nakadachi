import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { listingImages, sessions } from "~/db/schema/index.ts";
import { appContext, type AppContext } from "~/server/app-context";
import { csrfCookieName, issueCsrfToken } from "~/server/csrf.server";
import type { Db } from "~/server/db.server";
import { RATE_LIMITS } from "~/server/rate-limit.server";
import { createSession } from "~/server/session.server";
import { closeTestDb, makeDraft, makeUser, resetDatabase, testEnv, testLogger } from "./helpers.ts";

import { loader as rawContactLoader } from "~/routes/listings.contact";
import { action as rawFavoriteAction } from "~/routes/listings.favorite";
import { action as rawLogoutAction } from "~/routes/logout";
import { loader as rawMediaLoader } from "~/routes/media";
import { action as rawBlockAction } from "~/routes/users.block";

/**
 * ★loader・action の外へ AppError を漏らさない。★（監査 AUTH-08・E-10-1）
 *
 * 本番の React Router は、Response 以外の例外を «Unexpected Server Error»・500 に
 * 置き換える。開発中と検査では置き換えないので、AppError のまま投げていても
 * 手元では正しく見える。ここでは «投げられた物の形» を見る:
 * ルートのエラー応答（data() で包んだもの）なら本番でも状態と文言が届く。
 */

type RouteFn = (args: {
  request: Request;
  context: RouterContextProvider;
  params: Record<string, string>;
}) => Promise<unknown>;

const favoriteAction = rawFavoriteAction as unknown as RouteFn;
const blockAction = rawBlockAction as unknown as RouteFn;
const logoutAction = rawLogoutAction as unknown as RouteFn;
const contactLoader = rawContactLoader as unknown as RouteFn;
const mediaLoader = rawMediaLoader as unknown as RouteFn;

let db: Db;
const env = testEnv();

beforeEach(async () => {
  db = await resetDatabase();
});

afterAll(async () => {
  await closeTestDb();
});

function cookiePair(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf(";"));
}

async function signIn(userId: string): Promise<string> {
  const { setCookie } = await createSession({
    db,
    env,
    userId,
    request: new Request(env.APP_ORIGIN),
  });
  return cookiePair(setCookie);
}

function makeContext(): RouterContextProvider {
  const context = new RouterContextProvider();
  const app: AppContext = {
    env,
    ctx: {} as ExecutionContext,
    defer: () => undefined,
    getDb: () => db,
    logger: testLogger,
    nonce: "test-nonce",
    requestId: "test-request",
    setCookie: () => undefined,
    csrfToken: "",
  };
  context.set(appContext, app);
  return context;
}

/** CSRF の対を付けて（または付けずに）POST する */
async function post(
  fn: RouteFn,
  path: string,
  options: { cookies: string; params: Record<string, string>; form?: Record<string, string>; csrf: boolean },
): Promise<unknown> {
  const { token, cookieValue } = await issueCsrfToken(env);
  const body = new URLSearchParams(options.form ?? {});
  if (options.csrf) body.set("_csrf", token);
  const request = new Request(new URL(path, env.APP_ORIGIN), {
    method: "POST",
    headers: {
      origin: env.APP_ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${options.cookies}; ${csrfCookieName(env)}=${cookieValue}`,
    },
    body,
  });
  return fn({ request, context: makeContext(), params: options.params });
}

/** 投げられた物を受け取る（投げなければ失敗にする） */
async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (thrown) {
    return thrown;
  }
  throw new Error("投げられなかった");
}

const CSRF_MESSAGE = "セッションの確認に失敗しました";

describe("★CSRF の照合に落ちても 500 にしない★", () => {
  it("お気に入り", async () => {
    const owner = await makeUser(db, "owner@example.test");
    const viewer = await makeUser(db, "viewer@example.test");
    const listingId = await makeDraft(db, owner.id);
    const thrown = await thrownBy(
      post(favoriteAction, `/listings/${listingId}/favorite`, {
        cookies: await signIn(viewer.id),
        params: { listingId },
        csrf: false,
      }),
    );
    expect(thrown).not.toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      type: "DataWithResponseInit",
      init: { status: 403 },
      data: { message: expect.stringContaining(CSRF_MESSAGE) },
    });
  });

  it("ブロック", async () => {
    const me = await makeUser(db, "me@example.test");
    const other = await makeUser(db, "other@example.test");
    const thrown = await thrownBy(
      post(blockAction, `/users/${other.id}/block`, {
        cookies: await signIn(me.id),
        params: { userId: other.id },
        csrf: false,
      }),
    );
    expect(thrown).not.toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ init: { status: 403 } });
  });

  it("ログアウト", async () => {
    const me = await makeUser(db, "me@example.test");
    const thrown = await thrownBy(
      post(logoutAction, "/logout", { cookies: await signIn(me.id), params: {}, csrf: false }),
    );
    expect(thrown).not.toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      init: { status: 403 },
      data: { message: expect.stringContaining(CSRF_MESSAGE) },
    });
  });
});

describe("ブロック: 自分自身を指定しても 500 にしない", () => {
  it("400 のルートのエラー応答になる", async () => {
    const me = await makeUser(db, "me@example.test");
    const thrown = await thrownBy(
      post(blockAction, `/users/${me.id}/block`, {
        cookies: await signIn(me.id),
        params: { userId: me.id },
        csrf: true,
      }),
    );
    expect(thrown).not.toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ init: { status: 400 } });
  });
});

describe("★会話の開始: 回数制限に当たっても 500 にしない★", () => {
  it("上限を超えると、画面の文言として返る（投げない）", async () => {
    const owner = await makeUser(db, "owner@example.test");
    const asker = await makeUser(db, "asker@example.test");
    // 公開中でない投稿なので、上限までは «お問い合わせできない» の文言で返る。
    const listingId = await makeDraft(db, owner.id);
    const cookies = await signIn(asker.id);

    async function open(): Promise<unknown> {
      const request = new Request(new URL(`/listings/${listingId}/contact`, env.APP_ORIGIN), {
        headers: { cookie: cookies },
      });
      return contactLoader({ request, context: makeContext(), params: { listingId } });
    }

    for (let i = 0; i < RATE_LIMITS.threadCreate.max; i += 1) {
      const result = (await open()) as { message: string };
      expect(result.message).not.toContain("操作が続けて");
    }
    const over = (await open()) as { message: string };
    expect(over.message).toContain("操作が続けて行われました");
  });
});

describe("★写真の配信ではログインの期限を延ばさない★", () => {
  /*
   * 公開中の写真は共有キャッシュに置く応答なので、Worker は Set-Cookie を足さない。
   * ここで延長を走らせると «DB だけ延びて Cookie は古いまま» になり、次の画面でも
   * 延ばされず、Cookie の期限で先にログアウトしていた（PR-D のレビューで発覚）。
   */
  it("延長の閾値を切ったセッションで公開中の写真を開いても、DB の期限は変わらない", async () => {
    const owner = await makeUser(db, "owner@example.test");
    const viewer = await makeUser(db, "viewer@example.test");
    const listingId = await makeDraft(db, owner.id, {
      status: "published",
      publishedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    const objectKey = `listings/${listingId}/01JQZZZZZZZZZZZZZZZZZZZZZZ`;
    await db.insert(listingImages).values({
      id: "01JQZZZZZZZZZZZZZZZZZZZZZZ",
      listingId,
      objectKey,
      contentType: "image/png",
      byteSize: 4,
      width: 100,
      height: 100,
      checksumSha256: "0".repeat(64),
    });

    const cookies = await signIn(viewer.id);
    // 残りを10日にする（30日の半分を切っているので、画面なら延長される）。
    const tenDays = new Date(Date.now() + 10 * 86_400_000);
    await db.update(sessions).set({ expiresAt: tenDays }).where(eq(sessions.userId, viewer.id));

    const deferred: Promise<unknown>[] = [];
    const setCookies: string[] = [];
    const context = new RouterContextProvider();
    const media = {
      get: () =>
        Promise.resolve({
          body: new Uint8Array([1, 2, 3, 4]),
          size: 4,
          httpEtag: '"etag"',
        }),
    } as unknown as R2Bucket;
    const app: AppContext = {
      env: { ...env, MEDIA: media },
      ctx: {} as ExecutionContext,
      defer: (promise) => deferred.push(promise),
      getDb: () => db,
      logger: testLogger,
      nonce: "test-nonce",
      requestId: "test-request",
      setCookie: (value) => setCookies.push(value),
      csrfToken: "",
    };
    context.set(appContext, app);

    const response = (await mediaLoader({
      request: new Request(new URL(`/media/${objectKey}`, env.APP_ORIGIN), {
        headers: { cookie: cookies },
      }),
      context,
      params: { objectKey },
    })) as Response;
    await response.arrayBuffer();
    /*
     * ★閲覧者の照会は裏で走る。★ 公開中の写真では待たれずに応答が先に返るので、
     * すぐに見ると、延長（defer への登録と Set-Cookie）がまだ起きていないだけで緑になる。
     * 裏の照会が済むだけの時間を置いてから、預かった処理を片付けて見る。
     */
    await new Promise((resolve) => setTimeout(resolve, 500));
    await Promise.allSettled(deferred);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("public");
    expect(setCookies).toEqual([]);
    const rows = await db
      .select({ expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.userId, viewer.id));
    expect(rows[0]!.expiresAt.getTime()).toBe(tenDays.getTime());
  });
});
