import { describe, expect, it } from "vitest";

import { safeRedirectPath } from "~/domain/validation/common";

/**
 * 戻り先（?next=）の検査。
 *
 * ★2026-08-19 の公開前監査で、タブ文字で外部サイトへ飛ばせることが分かった。★
 * URL の仕様ではタブ・CR・LF は解釈の前に取り除かれるので、"/<TAB>/evil.com" は
 * 文字列としては "//" で始まっていないのに、ブラウザでは "//evil.com" になる。
 *
 * ★このサイトはパスワードを持たない。★ 自分のドメインから偽のログイン画面へ
 * 送り出せると、6桁のコードを取られて終わる。ここは前方一致だけに頼らない。
 */
describe("safeRedirectPath", () => {
  /** ブラウザ（と Location ヘッダ）が最終的にどこへ行くかで判定する */
  function landsOn(path: string): string {
    const headers = new Headers();
    try {
      headers.set("Location", path);
    } catch {
      return "(ヘッダに載せられない)";
    }
    return new URL(headers.get("Location")!, "https://nakadachi.rewrite-co.com").origin;
  }

  const OURS = "https://nakadachi.rewrite-co.com";

  it("★外部へ飛ばせない★", () => {
    const attempts = [
      "//evil.example",
      // ★バックスラッシュは2つ書く。★ "\e" は e になるだけで、
      // "/evil.example" という★安全な相対パス★を検査していた。
      // ブラウザは "/\" を "//" と同じに扱うので、ここが本命の1つ。
      "/\\evil.example",
      "/\\\\evil.example",
      "https:/evil.example",
      "https://evil.example",
      "\t//evil.example",
      "/\t/evil.example", // ← 実際に通っていた形
      "/\t\t//evil.example",
      "/\n//evil.example",
      "/\r//evil.example",
      "/\r\n//evil.example",
      "//\tevil.example",
      "/\t\\evil.example",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
    ];
    for (const attempt of attempts) {
      const result = safeRedirectPath(attempt);
      expect(landsOn(result), `${JSON.stringify(attempt)} が外部へ抜けた`).toBe(OURS);
    }
  });

  it("正しい戻り先はそのまま通す", () => {
    expect(safeRedirectPath("/mypage")).toBe("/mypage");
    expect(safeRedirectPath("/mypage/messages?a=1")).toBe("/mypage/messages?a=1");
    expect(safeRedirectPath("/search?q=%E6%9C%AC")).toBe("/search?q=%E6%9C%AC");
    expect(safeRedirectPath("/listings/01ABCDEFGHJKMNPQRSTVWXYZ00#photos")).toBe(
      "/listings/01ABCDEFGHJKMNPQRSTVWXYZ00#photos",
    );
  });

  it("空・型違い・相対パスは既定値へ", () => {
    expect(safeRedirectPath("")).toBe("/mypage");
    expect(safeRedirectPath(undefined)).toBe("/mypage");
    expect(safeRedirectPath(null)).toBe("/mypage");
    expect(safeRedirectPath(123)).toBe("/mypage");
    expect(safeRedirectPath("mypage")).toBe("/mypage");
    expect(safeRedirectPath("../admin")).toBe("/mypage");
    expect(safeRedirectPath("/admin", "/")).toBe("/admin");
  });
});
