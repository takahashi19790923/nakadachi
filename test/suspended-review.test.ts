import { describe, expect, it } from "vitest";

import {
  daysSince,
  needsSuspendedReview,
  SUSPENDED_REVIEW_DAYS,
} from "~/domain/retention";

/**
 * 停止したままの投稿に気づくための判定。
 *
 * ★停止は保持期間の対象外。★ 係争の経緯を残すため、自動では消さない
 * （retention.ts の ENDED_LISTING_STATUSES に suspended を入れていない）。
 * 代わりに「対応が終わったら人が削除する」決まりになっている。
 *
 * ★その «人が覚えている» を当てにしない。★ 一定日数を過ぎたものを
 * 管理画面に出す。出さなければ、止めた投稿は永久に貯まる。
 *
 * 実際、今日まで削除するボタン自体が存在しなかった（#52 で配線）。
 * 逃げ道が無いまま「消したい場合は管理画面から」と書かれていた。
 */

/** 検査は now を固定する。渡せないと実行した日で境界がずれる */
const NOW = new Date("2026-08-29T00:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

describe("経過日数", () => {
  it("ちょうどの日数を返す", () => {
    expect(daysSince(daysAgo(0), NOW)).toBe(0);
    expect(daysSince(daysAgo(1), NOW)).toBe(1);
    expect(daysSince(daysAgo(90), NOW)).toBe(90);
  });

  it("文字列でも受ける（loaderData は ISO 文字列で渡る）", () => {
    expect(daysSince(daysAgo(30).toISOString(), NOW)).toBe(30);
  });

  it("壊れた値で落ちない", () => {
    expect(daysSince("これは日付ではない", NOW)).toBe(0);
  });
});

describe("★停止したまま放置されていないか★", () => {
  it(`${SUSPENDED_REVIEW_DAYS}日を過ぎたら出す`, () => {
    expect(needsSuspendedReview("suspended", daysAgo(SUSPENDED_REVIEW_DAYS), NOW)).toBe(true);
    expect(needsSuspendedReview("suspended", daysAgo(SUSPENDED_REVIEW_DAYS + 1), NOW)).toBe(true);
  });

  it("★まだ日が浅いものは出さない★", () => {
    // 止めた直後から鳴ると、対応中の案件で毎回鳴って読まれなくなる。
    expect(needsSuspendedReview("suspended", daysAgo(SUSPENDED_REVIEW_DAYS - 1), NOW)).toBe(false);
    expect(needsSuspendedReview("suspended", daysAgo(0), NOW)).toBe(false);
  });

  it("★時刻が分からないものは «古い» とみなす★", () => {
    /*
     * closed_at を停止でも入れるようにしたのは 2026-08-29。それ以前に
     * 止めた行は時刻を持っていない。読み替えても分からない場合、
     * 「新しい」と扱うと永久に出てこない。古い側に倒す。
     */
    expect(needsSuspendedReview("suspended", null, NOW)).toBe(true);
  });

  it("停止以外は対象にしない", () => {
    for (const status of ["published", "closed", "expired", "rejected", "draft"] as const) {
      expect(needsSuspendedReview(status, daysAgo(9999), NOW)).toBe(false);
    }
  });
});
