import { describe, expect, it } from "vitest";

import { listingPublishedEmail } from "~/server/services/email/templates.server";

/**
 * 公開のお知らせ（監査 JOB-05）。
 *
 * ★求人の掲載者には «募集が終わったり変わったりしたら、すぐに終了・編集を» と依頼する。★
 * 職業安定法施行規則4条の3第4項3号ロ(1)（募集の終了・変更を速やかに通知するよう依頼する）。
 */
describe("公開のお知らせ", () => {
  const base = {
    title: "週末のアルバイト",
    listingUrl: "https://example.test/listings/x",
    expiresAt: "2026年11月3日",
  };

  it("お仕事では、終了・変更の依頼を本文（HTML とテキストの両方）に入れる", () => {
    const mail = listingPublishedEmail({ ...base, isJob: true });
    expect(mail.text).toContain("募集が終わったときは、すぐにマイページから掲載を編集・終了してください");
    expect(mail.html).toContain("募集が終わったときは、すぐにマイページから掲載を編集・終了してください");
  });

  it("ほかのカテゴリでは入れない", () => {
    const mail = listingPublishedEmail(base);
    expect(mail.text).not.toContain("募集が終わったとき");
    expect(mail.html).not.toContain("募集が終わったとき");
  });
});
