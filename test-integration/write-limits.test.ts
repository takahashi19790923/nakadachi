import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { favorites, listingImages, listings } from "~/db/schema/index.ts";
import { appContext, type AppContext } from "~/server/app-context";
import { csrfCookieName, issueCsrfToken } from "~/server/csrf.server";
import type { Db } from "~/server/db.server";
import { consumeRateLimit, RATE_LIMITS, type RateLimitName } from "~/server/rate-limit.server";
import { createSession } from "~/server/session.server";
import { closeTestDb, makeDraft, makeUser, resetDatabase, testEnv, testLogger } from "./helpers.ts";

import { action as rawCloseAction } from "~/routes/listings.close";
import { action as rawFavoriteAction } from "~/routes/listings.favorite";
import { action as rawImagesAction } from "~/routes/listings.images";
import { action as rawEditAction } from "~/routes/listings.edit";
import { action as rawProfileAction } from "~/routes/mypage.profile";
import { action as rawBlockAction } from "~/routes/users.block";

/**
 * ★書き込みの回数に上限がある。★（監査 SEC-04）
 *
 * 以前はプロフィール・投稿の編集・掲載の終了・お気に入り・ブロックに上限が無く、1つのアカウントから
 * DB への書き込みを好きなだけ積めた。上限は入力の検証より前で数えるので、
 * 中身が通らない送信でも数に入る（ここではそれを利用して、上限まで素早く送る）。
 */

type RouteFn = (args: {
  request: Request;
  context: RouterContextProvider;
  params: Record<string, string>;
}) => Promise<unknown>;

let db: Db;
const env = testEnv();

beforeEach(async () => {
  db = await resetDatabase();
});

afterAll(async () => {
  await closeTestDb();
});

async function signIn(userId: string): Promise<string> {
  const { setCookie } = await createSession({
    db,
    env,
    userId,
    request: new Request(env.APP_ORIGIN),
  });
  return setCookie.slice(0, setCookie.indexOf(";"));
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

async function post(
  fn: RouteFn,
  path: string,
  cookies: string,
  params: Record<string, string>,
  form: Record<string, string>,
): Promise<{ message?: string | null }> {
  const { token, cookieValue } = await issueCsrfToken(env);
  const request = new Request(new URL(path, env.APP_ORIGIN), {
    method: "POST",
    headers: {
      origin: env.APP_ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${cookies}; ${csrfCookieName(env)}=${cookieValue}`,
    },
    body: new URLSearchParams({ ...form, _csrf: token }),
  });
  try {
    return (await fn({ request, context: makeContext(), params })) as { message?: string | null };
  } catch (thrown) {
    // 成功したときの転送（3xx の Response）だけを成功として扱う。
    // ★404 などは飲み込まない。★ 飲み込むと、正常に通っていない送信まで «上限の下で通った» に数える。
    if (thrown instanceof Response) {
      if (thrown.status >= 300 && thrown.status < 400) return { message: null };
      throw new Error(`想定外の応答 ${thrown.status}`, { cause: thrown });
    }
    // asRouteError で包んだルートのエラー応答（お気に入り・ブロック）。文言を取り出す。
    if (typeof thrown === "object" && thrown !== null && "init" in thrown) {
      return { message: (thrown as { data?: { message?: string } }).data?.message ?? null };
    }
    throw thrown;
  }
}

const LIMITED = "操作が続けて行われました";

/** 公開中の投稿にする上書き */
function published() {
  return {
    status: "published" as const,
    publishedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
  };
}

async function expectLimited(
  name: RateLimitName,
  send: () => Promise<{ message?: string | null }>,
) {
  const max = RATE_LIMITS[name].max;
  for (let i = 0; i < max; i += 1) {
    const result = await send();
    expect(result.message ?? "", `${name} の ${i + 1}回目`).not.toContain(LIMITED);
  }
  const over = await send();
  expect(over.message ?? "", `${name} の上限を超えた回`).toContain(LIMITED);
}

describe("★書き込みの回数に上限がある★", () => {
  it("プロフィールの更新", async () => {
    const user = await makeUser(db, "profile@example.test");
    const cookies = await signIn(user.id);
    const send = (as: string) =>
      post(rawProfileAction as unknown as RouteFn, "/mypage/profile", as, {}, {
        displayName: "テスト",
        bio: "",
      });
    await expectLimited("profileUpdate", () => send(cookies));

    // ★数えるのは利用者ごと。★ 別の人は止まらない。
    const other = await makeUser(db, "other-profile@example.test");
    const otherResult = await send(await signIn(other.id));
    expect(otherResult.message ?? "").not.toContain(LIMITED);
  });

  it("投稿の編集", async () => {
    const user = await makeUser(db, "edit@example.test");
    const listingId = await makeDraft(db, user.id);
    const cookies = await signIn(user.id);
    // 中身は検証で落ちる形でよい（上限は検証より前で数える）。
    await expectLimited("listingEdit", () =>
      post(rawEditAction as unknown as RouteFn, `/listings/${listingId}/edit`, cookies, { listingId }, {
        title: "",
      }),
    );
  });

  it("お気に入りの追加・解除", async () => {
    const owner = await makeUser(db, "owner@example.test");
    const user = await makeUser(db, "fav@example.test");
    // 公開中の投稿（お気に入りにできるのは公開中だけ）。上限の下では実際に登録される。
    const listingId = await makeDraft(db, owner.id, published());
    const cookies = await signIn(user.id);
    await expectLimited("favoriteToggle", () =>
      post(rawFavoriteAction as unknown as RouteFn, `/listings/${listingId}/favorite`, cookies, { listingId }, {
        intent: "add",
      }),
    );
    const rows = await db.select().from(favorites).where(eq(favorites.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it("ブロック・解除", async () => {
    const user = await makeUser(db, "blocker@example.test");
    const other = await makeUser(db, "other@example.test");
    const cookies = await signIn(user.id);
    await expectLimited("blockToggle", () =>
      post(rawBlockAction as unknown as RouteFn, `/users/${other.id}/block`, cookies, { userId: other.id }, {
        intent: "block",
      }),
    );
  });

  it("掲載の終了", async () => {
    const user = await makeUser(db, "close@example.test");
    const listingId = await makeDraft(db, user.id, published());
    const cookies = await signIn(user.id);
    // 1回目で公開中→終了になる。2回目以降は «この状態ではできない» で断られるが、上限は先に数える。
    await expectLimited("listingClose", () =>
      post(rawCloseAction as unknown as RouteFn, `/listings/${listingId}/close`, cookies, { listingId }, {
        intent: "close",
      }),
    );
    const [row] = await db
      .select({ status: listings.status })
      .from(listings)
      .where(eq(listings.id, listingId));
    expect(row!.status).toBe("closed");
  });
});

describe("★写真を外す操作は、上限に当たっても止めない★", () => {
  /*
   * 外すのは利用者を守る操作。写真の追加の枠（imageUpload）を使い切った人も外せること。
   * 一度は同じ枠で数えていて、上限に当たると1時間外せなかった（2026-10-04 の反証）。
   */
  it("追加の枠を使い切っても、写真を外せる（追加は止まる）", async () => {
    const user = await makeUser(db, "photo-remove@example.test");
    const listingId = await makeDraft(db, user.id);
    const imageId = "01JQZZZZZZZZZZZZZZZZZZZZZZ";
    await db.insert(listingImages).values({
      id: imageId,
      listingId,
      objectKey: `listings/${listingId}/${imageId}`,
      contentType: "image/png",
      byteSize: 4,
      width: 100,
      height: 100,
      checksumSha256: "0".repeat(64),
    });
    for (let i = 0; i < RATE_LIMITS.imageUpload.max; i += 1) {
      await consumeRateLimit(db, "imageUpload", user.id);
    }
    const cookies = await signIn(user.id);
    const images = rawImagesAction as unknown as RouteFn;

    // 追加は止まる（枠を使い切っていることの確認）。
    const upload = await post(images, `/listings/${listingId}/images`, cookies, { listingId }, {
      intent: "upload",
    });
    expect(upload.message ?? "").toContain(LIMITED);

    // 外すのは通る。
    const removed = await post(images, `/listings/${listingId}/images`, cookies, { listingId }, {
      intent: "remove",
      imageId,
    });
    expect(removed.message ?? "").not.toContain(LIMITED);
    const [row] = await db
      .select({ deletedAt: listingImages.deletedAt })
      .from(listingImages)
      .where(eq(listingImages.id, imageId));
    expect(row!.deletedAt).not.toBeNull();
  });
});
