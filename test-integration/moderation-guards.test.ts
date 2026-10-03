import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { listingImages, reports } from "~/db/schema/index.ts";
import { ulid } from "~/domain/ulid";
import type { Db } from "~/server/db.server";
import { AppError } from "~/server/errors";
import { getPublishedListing } from "~/server/repositories/listing-repository.server";
import { setUserStatus } from "~/server/repositories/user-repository.server";
import {
  createDraft,
  flagPublishedListing,
  transitionListing,
} from "~/server/services/listing-service.server";
import {
  MAX_PUBLIC_IMAGE_CACHE_SECONDS,
  resolveMediaAccess,
} from "~/server/services/media/media-service.server";
import { ensureThread } from "~/server/services/message-service.server";
import { setSiteFlags } from "~/server/services/site-flags.server";
import { listingInputSchema } from "~/domain/validation/listing";
import { InvalidTransitionError } from "~/domain/listing-status";
import { closeTestDb, makeDraft, makeUser, resetDatabase, testLogger } from "./helpers.ts";

/**
 * 停止・認可・禁止語の守り（2026-10 の監査 AUTHZ-02・PRIV-06・AUTHZ-03・SEC-06・FN-09）。
 * 監査の再現検査（evidence/repro-zz-audit-repro）を、直った向きに反転したもの。
 */
let db: Db;

beforeEach(async () => {
  db = await resetDatabase();
});

afterAll(async () => {
  await closeTestDb();
});

async function addImage(listingId: string): Promise<string> {
  const id = ulid();
  const objectKey = `listings/${listingId}/${id}`;
  await db.insert(listingImages).values({
    id,
    listingId,
    objectKey,
    contentType: "image/jpeg",
    byteSize: 1000,
    width: 800,
    height: 600,
    checksumSha256: "0".repeat(64),
    position: 0,
  });
  return objectKey;
}

/** notFound() は 404 の Response を投げる（存在を知らせないため本文なし） */
async function expectNotFound(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Response);
  expect((error as Response).status).toBe(404);
}

describe("写真の配信は掲載の公開判定と同じ（AUTHZ-02）", () => {
  it("停止された利用者の掲載の写真は、誰にも配らない", async () => {
    const owner = await makeUser(db, "suspended-owner@example.test");
    const listingId = await makeDraft(db, owner.id, {
      status: "published",
      publishedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const key = await addImage(listingId);
    await setUserStatus(db, { userId: owner.id, status: "suspended", reason: "検査" });

    expect(await getPublishedListing(db, listingId)).toBeNull();
    await expectNotFound(resolveMediaAccess({ db, objectKey: key, viewer: null }));
  });

  it("期限を過ぎた（まだ expired に切り替わっていない）掲載の写真も配らない", async () => {
    const owner = await makeUser(db, "expired-owner@example.test");
    const listingId = await makeDraft(db, owner.id, {
      status: "published",
      publishedAt: new Date(Date.now() - 2 * 86_400_000),
      expiresAt: new Date(Date.now() - 1000),
    });
    const key = await addImage(listingId);
    await expectNotFound(resolveMediaAccess({ db, objectKey: key, viewer: null }));
  });

  it("公開中の写真は配り、キャッシュは掲載の終了まで（最長1日）にする（PRIV-06）", async () => {
    const owner = await makeUser(db, "public-owner@example.test");
    const soon = await makeDraft(db, owner.id, {
      status: "published",
      publishedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000), // 1時間後に終わる
    });
    const later = await makeDraft(db, owner.id, {
      status: "published",
      publishedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    const soonAccess = await resolveMediaAccess({ db, objectKey: await addImage(soon), viewer: null });
    expect(soonAccess.cacheable).toBe(true);
    expect(soonAccess.maxAgeSeconds).toBeLessThanOrEqual(3600);
    expect(soonAccess.maxAgeSeconds).toBeGreaterThan(3500);
    const laterAccess = await resolveMediaAccess({ db, objectKey: await addImage(later), viewer: null });
    expect(laterAccess.maxAgeSeconds).toBe(MAX_PUBLIC_IMAGE_CACHE_SECONDS);
  });

  it("停止された人の写真でも、本人と管理者は見られる（キャッシュしない）", async () => {
    const owner = await makeUser(db, "owner-view@example.test");
    const admin = await makeUser(db, "admin-view@example.test", "admin");
    const listingId = await makeDraft(db, owner.id, {
      status: "published",
      publishedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const key = await addImage(listingId);
    await setUserStatus(db, { userId: owner.id, status: "suspended", reason: "検査" });
    const asAdmin = await resolveMediaAccess({ db, objectKey: key, viewer: { id: admin.id, role: "admin" } });
    expect(asAdmin.allowed).toBe(true);
    expect(asAdmin.cacheable).toBe(false);
    const asOwner = await resolveMediaAccess({ db, objectKey: key, viewer: { id: owner.id, role: "user" } });
    expect(asOwner.allowed).toBe(true);
    expect(asOwner.cacheable).toBe(false);
  });
});

describe("停止された投稿を本人が終了・削除へ進められない（AUTHZ-03）", () => {
  it("suspended → closed（本人）は止まる", async () => {
    const owner = await makeUser(db, "moderated-owner@example.test");
    const listingId = await makeDraft(db, owner.id, { status: "suspended" });
    const error = await transitionListing(db, { listingId, to: "closed", actor: "owner" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InvalidTransitionError);
  });

  it("管理者は今までどおり削除できる", async () => {
    const owner = await makeUser(db, "moderated-owner2@example.test");
    const listingId = await makeDraft(db, owner.id, { status: "suspended" });
    const result = await transitionListing(db, { listingId, to: "deleted", actor: "admin" });
    expect(result.changed).toBe(true);
  });
});

describe("禁止語は投稿の文字の欄すべてを照合する（SEC-06・SEC-07）", () => {
  const base = {
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

  it("地域メモに block の語があれば下書きを作れない", async () => {
    const owner = await makeUser(db, "banned-areanote@example.test");
    const input = listingInputSchema.parse({ ...base, areaNote: "駅前で闇バイトの相談" });
    const error = await createDraft(db, owner.id, input).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("validation_failed");
  });

  it("ゼロ幅文字や括弧を挟んでもすり抜けない（本文）", async () => {
    const owner = await makeUser(db, "banned-zwsp@example.test");
    for (const body of ["説明文です。闇\u200Bバイトの募集はしません十分な長さ", "説明文です。闇（バイト）の募集はしません十分な長さ"]) {
      const input = listingInputSchema.parse({ ...base, body });
      const error = await createDraft(db, owner.id, input).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("validation_failed");
    }
  });

  it("禁止語の無い投稿は今までどおり作れる", async () => {
    const owner = await makeUser(db, "clean@example.test");
    const input = listingInputSchema.parse({ ...base, areaNote: "駅の近く" });
    await expect(createDraft(db, owner.id, input)).resolves.toMatchObject({ listingId: expect.any(String) });
  });

  it("★文の区切りをまたいで禁止語にならない★（«貸し出し。子ども用» は «出し子» に当たらない）", async () => {
    const owner = await makeUser(db, "kids@example.test");
    const input = listingInputSchema.parse({
      ...base,
      title: "子ども用の自転車",
      body: "週末だけ貸し出し。子ども用です。お引き受け、子供服もあります。",
    });
    await expect(createDraft(db, owner.id, input)).resolves.toMatchObject({ listingId: expect.any(String) });
  });
});

describe("区切りを挟んで block の語をすり抜けた投稿は、公開時に確認待ちへ（2026-10 のレビュー）", () => {
  async function publishedWithBody(email: string, body: string) {
    const owner = await makeUser(db, email);
    return makeDraft(db, owner.id, {
      status: "published",
      publishedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      body,
    });
  }

  it("«闇。バイト» は確認待ちの通報が1件できる", async () => {
    const listingId = await publishedWithBody("across-1@example.test", "説明です。闇。バイトの募集はしていません。");
    await flagPublishedListing({ db, logger: testLogger, listingId });
    const rows = await db.select({ id: reports.id }).from(reports).where(eq(reports.targetListingId, listingId));
    expect(rows).toHaveLength(1);
  });

  it("«貸し出し。子ども用» は確認待ちにもならない（3文字の語は区切りまたぎで見ない）", async () => {
    const listingId = await publishedWithBody("across-2@example.test", "週末だけ貸し出し。子ども用です。お引き受け、子供服もあります。");
    await flagPublishedListing({ db, logger: testLogger, listingId });
    const rows = await db.select({ id: reports.id }).from(reports).where(eq(reports.targetListingId, listingId));
    expect(rows).toHaveLength(0);
  });
});

describe("メッセージを止めているときは会話も作らせない（FN-09）", () => {
  it("messagesPaused のとき ensureThread が止まる", async () => {
    const owner = await makeUser(db, "thread-owner@example.test");
    const inquirer = await makeUser(db, "thread-inquirer@example.test");
    const listingId = await makeDraft(db, owner.id, {
      status: "published",
      publishedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const admin = await makeUser(db, "flags-admin@example.test", "admin");
    // 画面と同じ経路で切り替える（読み取り側の30秒のキャッシュもここで捨てられる）
    await setSiteFlags(db, admin.id, { messagesPaused: true });
    try {
      const error = await ensureThread({ db, listingId, inquirerId: inquirer.id }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).message).toContain("メッセージの送信を一時的に停止");
    } finally {
      await setSiteFlags(db, admin.id, { messagesPaused: false });
    }
  });
});
