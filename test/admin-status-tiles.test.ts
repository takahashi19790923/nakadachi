import { describe, expect, it } from "vitest";

import {
  ADMIN_HIDDEN_STATUSES,
  ADMIN_STATUS_TILES,
  LISTING_STATUSES,
  LISTING_STATUS_LABEL,
} from "~/domain/listing-status";

/**
 * 管理画面の「投稿の状態」。
 *
 * ★状態の一覧を手で書いていて、payment_processing が抜けていた。★
 * 支払い手段は Stripe のダッシュボードで増やせるので、コンビニ払いや
 * 銀行振込を有効にした日から、★「入金確認中で止まっている投稿」が
 * 管理画面のどこにも出なくなる★。
 *
 * 事故のときに最初に開く画面で、いちばん見たい状態が消えている形になる。
 * マイページで見つけたのと同じ型（[[mypage-groups]] の検査と対）。
 */
describe("★管理画面に、状態を並べ忘れない★", () => {
  it("payment_processing を並べる（入金確認中で止まったものを見る場所）", () => {
    expect(ADMIN_STATUS_TILES).toContain("payment_processing");
  });

  it("★どの状態も、並べるか «出さない理由» を書くかのどちらか★", () => {
    /*
     * 状態を足したときに、黙って消えないようにする。
     * 出したくないなら ADMIN_HIDDEN_STATUSES に理由と一緒に書く。
     */
    const missing = LISTING_STATUSES.filter(
      (s) => !ADMIN_STATUS_TILES.includes(s) && !ADMIN_HIDDEN_STATUSES.includes(s),
    );
    expect(missing).toEqual([]);
  });

  it("deleted は出さない（件数の問い合わせが除いているので常に 0 になる）", () => {
    expect(ADMIN_STATUS_TILES).not.toContain("deleted");
  });

  it("同じ状態を二度並べない", () => {
    expect(ADMIN_STATUS_TILES).toHaveLength(new Set(ADMIN_STATUS_TILES).size);
  });

  it("並べる状態にはすべて日本語の名前がある", () => {
    // 名前が無いと undefined が画面に出る。
    for (const status of ADMIN_STATUS_TILES) {
      expect(LISTING_STATUS_LABEL[status]).toBeTruthy();
    }
  });
});
