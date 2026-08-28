import { describe, expect, it } from "vitest";

import { LISTING_STATUSES, type ListingStatus } from "~/domain/listing-status";
import {
  MYPAGE_GROUPS,
  MYPAGE_TABS,
  toMypageGroupCounts,
} from "~/server/services/engagement-service.server";

/**
 * マイページの数字と、その数字を押した先の一覧。
 *
 * ★本番で食い違っていた（2026-08-29 実測）。★
 * 一覧には掲載終了が2件あるのに、マイページの数字は「掲載終了 0」。
 * 画面側が `["draft","payment_pending","published","closed"]` という
 * 生の状態を1つずつ並べていて、タブの中身（closed / expired /
 * rejected / suspended）とずれていたため。
 *
 * ★expired は例外的な状態ではない。★ 30日で終わる普通の終わり方なので、
 * ★いずれ全部の投稿がここへ来る★。「私の投稿はどこへ行った」と探しに来た人が、
 * いちばん最初に見る数字で「ありません」と言われていた。
 *
 * サーバーは正常、テストは緑、Stripe も正常。数字だけが嘘をつく形だった。
 */

/** 本人には見せない状態。グループに入れないことを意図として書いておく */
const INTENTIONALLY_UNGROUPED: readonly ListingStatus[] = ["deleted"];

const grouped = MYPAGE_GROUPS.flatMap((g) => g.statuses as readonly string[]);

describe("★数字と一覧が同じ状態を見ている★", () => {
  it("掲載終了は closed だけでなく expired / rejected / suspended も数える", () => {
    const counts = toMypageGroupCounts({
      closed: 1,
      expired: 2,
      rejected: 3,
      suspended: 4,
    });
    const finished = counts.find((c) => c.key === "finished");
    expect(finished?.count).toBe(10);
  });

  it("★決済待ちは payment_processing も数える（コンビニ払いの確認中）★", () => {
    // ここが抜けると、払った人の投稿がどの数字にも出ない。
    const counts = toMypageGroupCounts({
      payment_pending: 1,
      payment_processing: 1,
    });
    expect(counts.find((c) => c.key === "payment")?.count).toBe(2);
  });

  it("該当が無ければ 0 を出す（未定義ではなく）", () => {
    for (const group of toMypageGroupCounts({})) {
      expect(group.count).toBe(0);
    }
  });

  it("★どの状態も、必ずどこかのグループに属する★", () => {
    /*
     * これが本体。状態を1つ足して、どのグループにも入れ忘れると、
     * その状態の投稿は★マイページのどの数字にも出なくなる★。
     * 型では防げない（状態は増えても既存のグループは valid なまま）。
     */
    const missing = LISTING_STATUSES.filter(
      (s) => !grouped.includes(s) && !INTENTIONALLY_UNGROUPED.includes(s),
    );
    expect(missing).toEqual([]);
  });

  it("同じ状態を2つのグループに入れない（二重に数えない）", () => {
    expect(grouped).toHaveLength(new Set(grouped).size);
  });

  it("★グループの状態と、押した先のタブの状態が一致する★", () => {
    for (const tab of ["drafts", "published", "finished"] as const) {
      const fromGroups = MYPAGE_GROUPS.filter((g) => g.tab === tab).flatMap(
        (g) => g.statuses as readonly string[],
      );
      expect([...MYPAGE_TABS[tab]].sort()).toEqual([...fromGroups].sort());
    }
  });

  it("グループは押せる先を必ず持つ", () => {
    for (const group of MYPAGE_GROUPS) {
      expect(Object.keys(MYPAGE_TABS)).toContain(group.tab);
    }
  });
});
