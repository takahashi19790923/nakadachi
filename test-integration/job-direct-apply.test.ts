import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { conversationParticipants, conversationThreads, favorites, listingCategoryDetails } from "~/db/schema/index.ts";
import { ulid } from "~/domain/ulid";
import type { Db } from "~/server/db.server";
import { toggleFavorite } from "~/server/services/engagement-service.server";
import { ensureThread, sendMessage } from "~/server/services/message-service.server";
import { startListingCheckout } from "~/server/services/payment/payment-service.server";
import {
  categoryId,
  closeTestDb,
  makeDraft,
  makeUser,
  resetDatabase,
  testEnv,
  testLogger,
} from "./helpers.ts";

/**
 * ★お仕事は、求職者の情報をこのサイトに集めない。★
 *
 * 応募は掲載者の外部の窓口（応募ページ・メール）へ直接してもらう。画面でボタンを
 * 隠すだけでは送信を書き換えれば通るので、サーバーで断ることを確かめる:
 *  - サイト内のメッセージ（会話の開始・送信）
 *  - お気に入りの追加（外すのはできる）
 *  - 応募の連絡先が無いお仕事の決済（Stripe を呼ぶ前）
 */

let db: Db;
let owner: { id: string };
let seeker: { id: string };
const realFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(async () => {
  db = await resetDatabase();
  owner = await makeUser(db, "employer@example.test");
  seeker = await makeUser(db, "seeker@example.test");
  fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    return Promise.reject(new Error("Stripe を呼んではいけない"));
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  await closeTestDb();
});

async function publishedJob(): Promise<string> {
  const listingId = await makeDraft(db, owner.id, {
    categoryId: await categoryId(db, "job"),
    kind: "part_time",
    priceUnit: "hour",
    status: "published",
    publishedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
  });
  await db
    .update(listingCategoryDetails)
    .set({ applyEmail: "jobs@example.test", companyName: "なかだち商店", workHours: "9:00〜17:00" })
    .where(eq(listingCategoryDetails.listingId, listingId));
  return listingId;
}

describe("★サイト内のメッセージは使えない★", () => {
  it("会話を始められない", async () => {
    const listingId = await publishedJob();
    await expect(ensureThread({ db, listingId, inquirerId: seeker.id })).rejects.toMatchObject({
      code: "conflict",
      detail: "message refused for direct-inquiry category: job",
    });
    expect(await db.select().from(conversationThreads)).toHaveLength(0);
  });

  it("前に作られた会話があっても、送れない", async () => {
    const listingId = await publishedJob();
    // 受付を止める前などに作られていた会話を、直接作って再現する。
    const threadId = ulid();
    await db.insert(conversationThreads).values({ id: threadId, listingId, initiatorId: seeker.id });
    await db.insert(conversationParticipants).values([
      { threadId, userId: owner.id, role: "owner" },
      { threadId, userId: seeker.id, role: "inquirer" },
    ]);
    await expect(
      sendMessage({ db, threadId, senderId: seeker.id, body: "応募したいです。よろしくお願いします。" }),
    ).rejects.toMatchObject({
      code: "conflict",
      detail: "message refused for direct-inquiry category: job",
    });
  });

  it("（対照）ほかのカテゴリでは今までどおり会話を始められる", async () => {
    const listingId = await makeDraft(db, owner.id, {
      status: "published",
      publishedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    await expect(ensureThread({ db, listingId, inquirerId: seeker.id })).resolves.toMatchObject({
      threadId: expect.any(String),
    });
  });
});

describe("★お気に入りに追加できない（外すのはできる）★", () => {
  it("追加は断り、行も増えない", async () => {
    const listingId = await publishedJob();
    await expect(
      toggleFavorite({ db, userId: seeker.id, listingId, desired: "add" }),
    ).rejects.toMatchObject({
      code: "conflict",
      detail: "favorite refused for direct-inquiry category: job",
    });
    expect(await db.select().from(favorites)).toHaveLength(0);
  });

  it("以前に入れたものは外せる", async () => {
    const listingId = await publishedJob();
    await db.insert(favorites).values({ userId: seeker.id, listingId });
    await expect(
      toggleFavorite({ db, userId: seeker.id, listingId, desired: "remove" }),
    ).resolves.toEqual({ favorited: false });
    expect(await db.select().from(favorites)).toHaveLength(0);
  });
});

describe("★応募の連絡先が無いお仕事は、決済に進めない★", () => {
  async function checkout(listingId: string) {
    return startListingCheckout({
      db,
      env: testEnv(),
      logger: testLogger,
      request: new Request("https://example.test/checkout", { method: "POST" }),
      listingId,
      userId: owner.id,
    });
  }

  it("連絡先の欄ができる前の下書きは、Stripe を呼ぶ前に止まる", async () => {
    const listingId = await makeDraft(db, owner.id, {
      categoryId: await categoryId(db, "job"),
      kind: "part_time",
      priceUnit: "hour",
    });
    await expect(checkout(listingId)).rejects.toMatchObject({
      code: "validation_failed",
      detail: `direct-inquiry listing without contact: ${listingId}`,
    });
    expect(fetchCalls).toBe(0);
  });

  it("連絡先があれば、この確認は通って決済の処理（Stripe）へ進む", async () => {
    const listingId = await makeDraft(db, owner.id, {
      categoryId: await categoryId(db, "job"),
      kind: "part_time",
      priceUnit: "hour",
    });
    await db
      .update(listingCategoryDetails)
      .set({ applyUrl: "https://example.com/recruit" })
      .where(eq(listingCategoryDetails.listingId, listingId));
    // この検査では Stripe を呼ぶと失敗させているので、そこまで進んだことを確かめる。
    await expect(checkout(listingId)).rejects.toBeTruthy();
    expect(fetchCalls).toBeGreaterThan(0);
  });
});

describe("★お仕事の詳細は、ログインの有無で中身が変わらない★", () => {
  /*
   * 求職者の情報（ログインしているか・お気に入りにしたか）を求人の表示に使わない作り。
   * 未ログインの人と、ログインした（投稿者でない）人に同じデータを返すことを確かめる。
   * 1回ごとに変わる CSRF のトークンだけは比べない。
   */
  async function detailFor(listingId: string, cookies: string | null) {
    const { RouterContextProvider } = await import("react-router");
    const { appContext } = await import("~/server/app-context");
    const { loader } = await import("~/routes/listing-detail");
    const context = new RouterContextProvider();
    context.set(appContext, {
      env: testEnv(),
      ctx: {} as ExecutionContext,
      defer: () => undefined,
      getDb: () => db,
      logger: testLogger,
      nonce: "n",
      requestId: "r",
      setCookie: () => undefined,
      csrfToken: "token",
    });
    const request = new Request(`https://example.test/listings/${listingId}`, {
      headers: cookies ? { cookie: cookies, "user-agent": "Googlebot" } : { "user-agent": "Googlebot" },
    });
    return (await (loader as unknown as (args: unknown) => Promise<Record<string, unknown>>)({
      request,
      context,
      params: { listingId },
    }));
  }

  it("未ログインとログイン中（お気に入りに入れていた人でも）で同じ", async () => {
    const listingId = await publishedJob();
    // 以前にお気に入りへ入れていた人でも、表示は変わらない。
    await db.insert(favorites).values({ userId: seeker.id, listingId });
    const { createSession } = await import("~/server/session.server");
    const { setCookie } = await createSession({
      db,
      env: testEnv(),
      userId: seeker.id,
      request: new Request("https://example.test/"),
    });
    const cookie = setCookie.slice(0, setCookie.indexOf(";"));

    const anonymous = await detailFor(listingId, null);
    const signedIn = await detailFor(listingId, cookie);
    expect(signedIn).toEqual(anonymous);
    expect(signedIn.favorited).toBe(false);
    expect(signedIn.isLoggedIn).toBe(false);

    /*
     * ★対照: 同じ Cookie で、ほかのカテゴリではログインとお気に入りが反映される。★
     * これが無いと、Cookie がそもそも効いていない（両方とも未ログイン）ときにも上が緑になる。
     */
    const otherListingId = await makeDraft(db, owner.id, {
      status: "published",
      publishedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    await db.insert(favorites).values({ userId: seeker.id, listingId: otherListingId });
    const control = await detailFor(otherListingId, cookie);
    expect(control.isLoggedIn).toBe(true);
    expect(control.favorited).toBe(true);
  });
});
