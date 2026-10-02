import { describe, expect, it } from "vitest";

import {
  CATEGORY_LIST,
  CATEGORY_SLUGS,
  categoryIntakePausedMessage,
  isCategoryAcceptingNew,
} from "~/domain/categories";

/**
 * カテゴリごとの «新しい掲載の受付»。
 *
 * ★止めるのは «お仕事» だけ。★ ほかを巻き込むと、投稿そのものができなくなる。
 * 一覧・検索・/c/:slug のためにカテゴリ自体は残す（CATEGORY_SLUGS は5つのまま）。
 */
describe("カテゴリの新規受付", () => {
  it("お仕事だけ受付を止め、ほかの4つは受け付ける", () => {
    expect(isCategoryAcceptingNew("job")).toBe(false);
    for (const slug of CATEGORY_SLUGS.filter((s) => s !== "job")) {
      expect(isCategoryAcceptingNew(slug)).toBe(true);
    }
  });

  it("カテゴリ自体は消さない（一覧・検索・/c/job のため）", () => {
    expect(CATEGORY_SLUGS).toContain("job");
    expect(CATEGORY_LIST.map((c) => c.slug)).toContain("job");
  });

  it("案内文にカテゴリ名が入る", () => {
    expect(categoryIntakePausedMessage("job")).toContain("お仕事");
    expect(categoryIntakePausedMessage("job")).toContain("停止");
  });
});
