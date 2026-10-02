import { describe, expect, it } from "vitest";

import { listingSuspendedEmail } from "~/server/services/email/templates.server";

/**
 * 非公開・却下のメール。
 *
 * ★同じ文を両方に使わない。★ 却下は «お支払いの後・公開の前» なら全額返金の
 * 対象（利用規約第5条2項）。非公開と同じ «返金はありません» を送ると、
 * 払った後に却下された人へ誤って伝わる。
 * ★HTML とテキストを同じ内容にする。★ 以前はテキスト版に返金の行が無かった。
 */
const base = { title: "テストの投稿", reason: "規約に照らして", contactUrl: "https://example.test/contact" };

describe("非公開・却下のメール", () => {
  it("非公開: 返金は無いこと・判断の誤りなら延長することを、HTML とテキストの両方に書く", () => {
    const mail = listingSuspendedEmail({ ...base, kind: "suspended", wasPublished: true });
    expect(mail.subject).toContain("非公開にしました");
    for (const body of [mail.html, mail.text]) {
      expect(body).toContain("返金はありません");
      expect(body).toContain("掲載期間を延長");
      expect(body).not.toContain("お支払い済みの場合は、全額を返金");
    }
  });

  it("公開前の却下: お支払い済みなら全額返金と書き、«返金はありません» とは書かない", () => {
    const mail = listingSuspendedEmail({ ...base, kind: "rejected", wasPublished: false });
    expect(mail.subject).toContain("見送りました");
    for (const body of [mail.html, mail.text]) {
      expect(body).toContain("お支払い済みの場合は、全額を返金");
      expect(body).not.toContain("返金はありません");
      expect(body).not.toContain("非公開にしました");
    }
  });

  it("公開後の却下: 返金は無いと書き、全額返金とは書かない", () => {
    const mail = listingSuspendedEmail({ ...base, kind: "rejected", wasPublished: true });
    for (const body of [mail.html, mail.text]) {
      expect(body).toContain("却下の場合、掲載料の返金はありません");
      expect(body).not.toContain("お支払い済みの場合は、全額を返金");
    }
  });
});
