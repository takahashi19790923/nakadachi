import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "~/server/db.server";
import {
  clearSiteFlagsCache,
  getSiteFlags,
  setSiteFlags,
} from "~/server/services/site-flags.server";
import { createDraft } from "~/server/services/listing-service.server";
import { sendMessage, ensureThread } from "~/server/services/message-service.server";

import {
  closeTestDb,
  makeDraft,
  makeUser,
  resetDatabase,
} from "./helpers.ts";

/**
 * 運用スイッチ。
 *
 * ★事故のときに «止める» 手段が、再デプロイしかなかった。★
 *
 * いちばん大事なのは★止まらないこと★。ここが誤って閉じると、
 * サイト全体が理由もなく使えなくなる。行が無い・DB が読めない場合は
 * 「全部動いている」とみなす（fail-open）。
 */
let db: Db;

const draftInput = {
  categorySlug: "sell-buy" as const,
  kind: "sell" as const,
  title: "テスト用の投稿",
  body: "テスト用の説明文です。十分な長さがあります。",
  priceJpy: 1000,
  priceType: "fixed" as const,
  priceUnit: "once" as const,
  itemCondition: "good" as const,
  handoverMethod: "either" as const,
  prefectureCode: "13",
  cityCode: "13107",
};

describe("運用スイッチ", () => {
  beforeEach(async () => {
    db = await resetDatabase();
    clearSiteFlagsCache();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("★行が無ければ «全部動いている»（fail-open）★", async () => {
    const flags = await getSiteFlags(db);
    expect(flags).toEqual({
      signupsPaused: false,
      listingsPaused: false,
      messagesPaused: false,
      notice: null,
    });
  });

  it("止めていなければ、投稿できる", async () => {
    const user = await makeUser(db, "flag-ok@example.test");
    await expect(createDraft(db, user.id, draftInput)).resolves.toBeTruthy();
  });

  it("★掲載を止めると、新しい投稿が作れない★", async () => {
    const admin = await makeUser(db, "flag-admin@example.test", "admin");
    const user = await makeUser(db, "flag-blocked@example.test");

    await setSiteFlags(db, admin.id, { listingsPaused: true });

    await expect(createDraft(db, user.id, draftInput)).rejects.toThrow();
  });

  it("案内文を入れると、それが利用者に出る", async () => {
    const admin = await makeUser(db, "flag-admin2@example.test", "admin");
    const user = await makeUser(db, "flag-notice@example.test");

    await setSiteFlags(db, admin.id, {
      listingsPaused: true,
      notice: "点検のため本日18時まで受付を停止しています。",
    });

    await expect(createDraft(db, user.id, draftInput)).rejects.toThrow(
      /点検のため/,
    );
  });

  it("★戻すと、また使えるようになる★", async () => {
    const admin = await makeUser(db, "flag-admin3@example.test", "admin");
    const user = await makeUser(db, "flag-restore@example.test");

    await setSiteFlags(db, admin.id, { listingsPaused: true });
    await expect(createDraft(db, user.id, draftInput)).rejects.toThrow();

    await setSiteFlags(db, admin.id, { listingsPaused: false });
    await expect(createDraft(db, user.id, draftInput)).resolves.toBeTruthy();
  });

  it("メッセージだけ止めても、投稿はできる（機能ごとに独立）", async () => {
    const admin = await makeUser(db, "flag-admin4@example.test", "admin");
    const owner = await makeUser(db, "flag-owner@example.test");
    const buyer = await makeUser(db, "flag-buyer@example.test");
    const listingId = await makeDraft(db, owner.id, { status: "published" });
    const { threadId } = await ensureThread({
      db,
      listingId,
      inquirerId: buyer.id,
    });

    await setSiteFlags(db, admin.id, { messagesPaused: true });

    // メッセージは止まる。
    await expect(
      sendMessage({ db, threadId, senderId: buyer.id, body: "こんにちは" }),
    ).rejects.toThrow();

    // 投稿は止まっていない。
    await expect(createDraft(db, owner.id, draftInput)).resolves.toBeTruthy();
  });

  it("誰が触ったかが残る", async () => {
    const admin = await makeUser(db, "flag-admin5@example.test", "admin");
    await setSiteFlags(db, admin.id, { signupsPaused: true });

    const flags = await getSiteFlags(db);
    expect(flags.signupsPaused).toBe(true);
    // 列としての updated_by は setSiteFlags が入れている（画面側は
    // writeAdminAction で理由も残す）。
  });

  it("★止めたつもりが «全部止まる» にならない★", async () => {
    const admin = await makeUser(db, "flag-admin6@example.test", "admin");
    const user = await makeUser(db, "flag-partial@example.test");

    // 登録だけ止める。
    await setSiteFlags(db, admin.id, { signupsPaused: true });

    // 既存の利用者の投稿は止まらない。
    await expect(createDraft(db, user.id, draftInput)).resolves.toBeTruthy();
  });
});
