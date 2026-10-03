import { RouterContextProvider } from "react-router";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { appContext, type AppContext } from "~/server/app-context";
import { csrfCookieName, issueCsrfToken } from "~/server/csrf.server";
import type { Db } from "~/server/db.server";
import { RATE_LIMITS } from "~/server/rate-limit.server";
import { createSession } from "~/server/session.server";
import { closeTestDb, makeDraft, makeUser, resetDatabase, testEnv, testLogger } from "./helpers.ts";

import { loader as rawContactLoader } from "~/routes/listings.contact";
import { action as rawFavoriteAction } from "~/routes/listings.favorite";
import { action as rawLogoutAction } from "~/routes/logout";
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
