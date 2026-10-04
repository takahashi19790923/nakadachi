import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * ★受付を止める仕組みは残してある。★ お仕事は 2026-10 に受付を再開したので、この検査では
 * お仕事を «止めた» 形にして、仕組みが3か所で効くことを確かめ続ける（どのカテゴリでも
 * 同じ関数を通る）。
 */
vi.mock("~/domain/categories", async (importOriginal) => {
  const actual = await importOriginal<typeof Categories>();
  return { ...actual, isCategoryAcceptingNew: (slug: string) => slug !== "job" };
});

import type * as Categories from "~/domain/categories";
import { categoryIntakePausedMessage } from "~/domain/categories";
import { listingInputSchema } from "~/domain/validation/listing";
import type { Db } from "~/server/db.server";
import { AppError } from "~/server/errors";
import { createDraft, updateListing } from "~/server/services/listing-service.server";
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
 * 受付を止めたカテゴリ（この検査ではお仕事を止めた形にしている。上の vi.mock）。
 *
 * ★画面で選べなくするだけでは足りない。★ 送信を書き換えれば作れてしまう。
 * 下書きの作成・下書きの編集・決済の開始の3か所で、サーバー側が止めること。
 * 決済は ★Stripe を呼ぶ前★ に止める（呼んでから止めると Session が残る）。
 */
let db: Db;
let userId: string;
const realFetch = globalThis.fetch;
let fetchCalls = 0;

const jobForm = {
  categorySlug: "job",
  kind: "part_time",
  title: "週末のアルバイト募集",
  body: "店舗の品出しと接客をお願いします。未経験でも大丈夫です。",
  priceType: "fixed",
  priceJpy: "1200",
  priceUnit: "hour",
  workHours: "9:00〜17:00",
  companyName: "なかだち商店",
  applyEmail: "jobs@example.test",
  prefectureCode: "13",
  cityCode: "13107",
  durationDays: "30",
};

const sellForm = {
  categorySlug: "sell-buy",
  kind: "sell",
  title: "テスト用の投稿",
  body: "テスト用の説明文です。十分な長さがあります。",
  priceType: "fixed",
  priceJpy: "1000",
  priceUnit: "once",
  itemCondition: "good",
  handoverMethod: "either",
  prefectureCode: "13",
  cityCode: "13107",
  durationDays: "30",
};

beforeEach(async () => {
  db = await resetDatabase();
  userId = (await makeUser(db, "intake@example.test")).id;
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

async function expectPaused(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).message).toBe(categoryIntakePausedMessage("job"));
  expect((error as AppError).detail).toBe("category intake paused: job");
}

describe("お仕事の新規受付の停止", () => {
  it("お仕事の下書きは作れない", async () => {
    const input = listingInputSchema.parse(jobForm);
    await expectPaused(createDraft(db, userId, input));
  });

  it("ほかのカテゴリの下書きは今までどおり作れる", async () => {
    const input = listingInputSchema.parse(sellForm);
    await expect(createDraft(db, userId, input)).resolves.toMatchObject({
      listingId: expect.any(String),
    });
  });

  it("以前からあるお仕事の下書きは、編集で先へ進められない", async () => {
    const listingId = await makeDraft(db, userId, {
      categoryId: await categoryId(db, "job"),
      kind: "part_time",
    });
    const input = listingInputSchema.parse(jobForm);
    await expectPaused(updateListing(db, listingId, input));
  });

  it("★公開中のお仕事は、今までどおり編集できる★（止めるのは下書きだけ）", async () => {
    const listingId = await makeDraft(db, userId, {
      categoryId: await categoryId(db, "job"),
      kind: "part_time",
      status: "published",
      publishedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const input = listingInputSchema.parse(jobForm);
    await expect(updateListing(db, listingId, input)).resolves.toBeUndefined();
  });

  it("以前からあるお仕事の下書きは、Stripe を呼ぶ前に決済で止まる", async () => {
    const listingId = await makeDraft(db, userId, {
      categoryId: await categoryId(db, "job"),
      kind: "part_time",
    });
    await expectPaused(
      startListingCheckout({
        db,
        env: testEnv(),
        logger: testLogger,
        request: new Request("https://example.test/checkout", { method: "POST" }),
        listingId,
        userId,
      }),
    );
    expect(fetchCalls).toBe(0);
  });
});
