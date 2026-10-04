import { describe, expect, it } from "vitest";

import {
  CATEGORIES,
  CATEGORY_LIST,
  CATEGORY_SLUGS,
  categoryIntakePausedMessage,
  isCategoryAcceptingNew,
  usesDirectInquiry,
} from "~/domain/categories";

/**
 * カテゴリごとの «新しい掲載の受付» と «問い合わせの受け方»。
 *
 * お仕事は 2026-10 に、求職者の情報を集めない作り（応募は掲載者の外部の窓口へ直接）に
 * 作り変えて受付を再開した。受付を止める仕組みそのものは残している
 * （test-integration/listing-intake.test.ts が、止めた形で3か所の拒否を確かめる）。
 */
describe("カテゴリの新規受付", () => {
  it("5つのカテゴリすべてで受け付ける", () => {
    for (const slug of CATEGORY_SLUGS) {
      expect(isCategoryAcceptingNew(slug), slug).toBe(true);
    }
  });

  it("カテゴリ自体は5つのまま", () => {
    expect(CATEGORY_SLUGS).toContain("job");
    expect(CATEGORY_LIST.map((c) => c.slug)).toContain("job");
  });

  it("止めるときの案内文にカテゴリ名が入る", () => {
    expect(categoryIntakePausedMessage("job")).toContain("お仕事");
    expect(categoryIntakePausedMessage("job")).toContain("停止");
  });
});

describe("★問い合わせの受け方★", () => {
  it("お仕事だけ «掲載者の外部の窓口へ直接»。ほかはサイト内のメッセージ", () => {
    expect(usesDirectInquiry("job")).toBe(true);
    expect(CATEGORIES.job.inquiry).toBe("direct");
    for (const slug of CATEGORY_SLUGS.filter((s) => s !== "job")) {
      expect(usesDirectInquiry(slug), slug).toBe(false);
    }
  });
});
