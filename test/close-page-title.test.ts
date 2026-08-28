import { describe, expect, it } from "vitest";

import {
  CLOSE_PAGE_HEADING,
  CLOSE_PAGE_INTENT,
  CLOSE_PAGE_TITLE,
  canTransition,
  closePageMode,
  LISTING_STATUSES,
  type ClosePageMode,
} from "~/domain/listing-status";

/**
 * 掲載終了／削除の確認画面。
 *
 * ★見出しと題名（<title>）が食い違っていた。★
 * 下書きの削除確認で、画面は「投稿を削除しますか？」なのに、
 * ブラウザのタブは「掲載を終了する」だった。meta() が状態を見ずに
 * 常に同じ題名を返していたため（2026-08-29 に本番で確認）。
 *
 * 体裁の問題に見えるが、ここは**取り消せない操作の確認画面**で、
 * タブ・履歴・ブックマーク・読み上げでは題名のほうが使われる。
 * 「終了」と「削除」が入れ替わって伝わる。
 */

const MODES: ClosePageMode[] = ["close", "delete", "blocked"];

/** その顔が使っている語（終了 / 削除） */
function keyword(text: string): string {
  if (text.includes("終了")) return "終了";
  if (text.includes("削除")) return "削除";
    return "(どちらでもない)";
}

describe("★題名と見出しが同じ語を使う★", () => {
  it.each(MODES)("%s の顔で、題名と見出しの語が一致する", (mode) => {
    expect(keyword(CLOSE_PAGE_TITLE[mode])).toBe(keyword(CLOSE_PAGE_HEADING[mode]));
    expect(keyword(CLOSE_PAGE_TITLE[mode])).not.toBe("(どちらでもない)");
  });

  it("下書きの画面は «削除»、公開中の画面は «終了» と言う", () => {
    // 取り違えるといちばん困る2つを名指しで固定する。
    expect(CLOSE_PAGE_TITLE[closePageMode("draft")]).toContain("削除");
    expect(CLOSE_PAGE_HEADING[closePageMode("draft")]).toContain("削除");
    expect(CLOSE_PAGE_TITLE[closePageMode("published")]).toContain("終了");
    expect(CLOSE_PAGE_HEADING[closePageMode("published")]).toContain("終了");
  });

  it("どの状態でも顔が決まる（未定義にならない）", () => {
    for (const status of LISTING_STATUSES) {
      const mode = closePageMode(status);
      expect(MODES).toContain(mode);
      expect(CLOSE_PAGE_TITLE[mode]).toBeTruthy();
      expect(CLOSE_PAGE_HEADING[mode]).toBeTruthy();
    }
  });
});

describe("★出したボタンが、実際に通る操作であること★", () => {
  /*
   * 押せるのに必ず失敗するボタンは、利用者から見ると「壊れている」としか
   * 映らない。画面の出し分けと遷移表がずれていないことを固定する。
   *
   * ここで見るのは «出したものは通る» の向きだけ。逆向き（遷移表が許して
   * いるのに画面を出していない）は、closed / suspended / rejected で
   * 実際に起きている。管理者側は配線したが、本人側は別の判断が要るので
   * ここでは固定しない。
   */
  it.each(LISTING_STATUSES.filter((s) => closePageMode(s) !== "blocked"))(
    "%s で出すボタンは遷移表でも許されている",
    (status) => {
      const mode = closePageMode(status);
      const to = mode === "close" ? "closed" : "deleted";
      expect(CLOSE_PAGE_INTENT[mode]).toBe(mode);
      expect(canTransition(status, to, "owner")).toBe(true);
    },
  );
});
