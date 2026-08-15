import { describe, expect, it } from "vitest";

import {
  InvalidTransitionError,
  LISTING_STATUSES,
  allowedTransitions,
  assertTransition,
  canTransition,
  isIndexable,
  isPubliclyVisible,
} from "~/domain/listing-status";

describe("投稿の状態遷移", () => {
  it("下書きから決済待ちへは本人だけが進められる", () => {
    expect(canTransition("draft", "payment_pending", "owner")).toBe(true);
    expect(canTransition("draft", "payment_pending", "system")).toBe(false);
    expect(canTransition("draft", "payment_pending", "admin")).toBe(false);
  });

  it("★下書きから公開できるのは payment だけ★（課金を飛ばせない）", () => {
    expect(canTransition("draft", "published", "owner")).toBe(false);
    expect(canTransition("draft", "published", "admin")).toBe(false);
    // ★system でも公開できない。★ 期限切れの取り込みや返金処理と
    // 同じ資格で公開できてしまうと、あとから足したサーバー処理が
    // 課金を通さずに掲載を出せる。
    expect(canTransition("draft", "published", "system")).toBe(false);

    /*
     * payment だけ通る。支払いの成立と決済の失効が前後して届いたとき、
     * 投稿は一度下書きへ戻ってから支払い成立の通知を受ける。
     * ここが通らないと ★110円を受け取ったのに掲載が出ない。★
     */
    expect(canTransition("draft", "published", "payment")).toBe(true);
  });

  it("★公開できるのは payment だけ★", () => {
    expect(canTransition("payment_pending", "published", "payment")).toBe(true);
    expect(canTransition("payment_processing", "published", "payment")).toBe(true);
    // 本人も管理者も、支払い以外のサーバー処理も、公開は起こせない。
    expect(canTransition("payment_pending", "published", "owner")).toBe(false);
    expect(canTransition("payment_pending", "published", "admin")).toBe(false);
    expect(canTransition("payment_pending", "published", "system")).toBe(false);
  });

  it("★payment で公開できるのは決済待ち・確認中・下書きからだけ★", () => {
    // 掲載終了や停止から payment で復活できると、1回の課金で
    // 何度でも掲載できる穴になる。
    for (const from of ["closed", "expired", "suspended", "rejected", "deleted"] as const) {
      expect(canTransition(from, "published", "payment")).toBe(false);
    }
  });

  it("★掲載終了から公開へは戻せない★（1回の課金で何度も掲載できない）", () => {
    expect(canTransition("closed", "published", "owner")).toBe(false);
    expect(canTransition("closed", "published", "admin")).toBe(false);
    expect(canTransition("closed", "published", "system")).toBe(false);
    expect(canTransition("closed", "published", "payment")).toBe(false);
    expect(canTransition("expired", "published", "owner")).toBe(false);
  });

  it("管理者が止めた投稿を本人が戻せない", () => {
    expect(canTransition("suspended", "published", "owner")).toBe(false);
    expect(canTransition("suspended", "published", "admin")).toBe(true);
  });

  it("返金・チャージバックでは system が公開を止められる", () => {
    expect(canTransition("published", "suspended", "system")).toBe(true);
  });

  it("削除は終端で、そこから戻れない", () => {
    for (const status of LISTING_STATUSES) {
      expect(canTransition("deleted", status, "admin")).toBe(false);
      expect(canTransition("deleted", status, "owner")).toBe(false);
      expect(canTransition("deleted", status, "system")).toBe(false);
    }
  });

  it("許されない遷移は例外になる", () => {
    expect(() => assertTransition("draft", "published", "owner")).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertTransition("draft", "payment_pending", "owner")).not.toThrow();
  });

  it("主体ごとに取れる遷移を列挙できる", () => {
    expect(allowedTransitions("published", "owner")).toEqual(["closed"]);
    expect(allowedTransitions("published", "admin").sort()).toEqual(
      ["deleted", "rejected", "suspended"].sort(),
    );
  });
});

describe("公開判定", () => {
  it("★公開中だけが誰でも見られる★", () => {
    expect(isPubliclyVisible("published")).toBe(true);
    for (const status of LISTING_STATUSES) {
      if (status === "published") continue;
      expect(isPubliclyVisible(status)).toBe(false);
    }
  });

  it("検索エンジンに載せてよいのも公開中だけ", () => {
    expect(isIndexable("published")).toBe(true);
    expect(isIndexable("draft")).toBe(false);
    expect(isIndexable("payment_pending")).toBe(false);
    expect(isIndexable("suspended")).toBe(false);
  });
});
