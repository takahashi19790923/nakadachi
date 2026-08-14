import { describe, expect, it } from "vitest";

import { ULID_LENGTH, isUlid, ulid, ulidTimestamp } from "~/domain/ulid";

describe("ULID", () => {
  it("26文字の Crockford base32 を返す", () => {
    const value = ulid();
    expect(value).toHaveLength(ULID_LENGTH);
    expect(value).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
  });

  it("★I L O U を含まない★（見間違いやすい文字を避けている）", () => {
    // 1000個作って、除外されている文字が一度も出ないことを見る。
    const generated = Array.from({ length: 1000 }, () => ulid()).join("");
    expect(generated).not.toMatch(/[ILOU]/);
  });

  it("同じミリ秒でも単調に増える", () => {
    const now = 1_700_000_000_000;
    const first = ulid(now);
    const second = ulid(now);
    const third = ulid(now);
    expect(first < second).toBe(true);
    expect(second < third).toBe(true);
  });

  it("時刻が進めば辞書順でも後ろになる", () => {
    const earlier = ulid(1_700_000_000_000);
    const later = ulid(1_700_000_001_000);
    expect(earlier < later).toBe(true);
  });

  it("重複しない", () => {
    const values = new Set(Array.from({ length: 10_000 }, () => ulid()));
    expect(values.size).toBe(10_000);
  });

  it("生成時刻を読み出せる", () => {
    const now = 1_700_000_000_000;
    expect(ulidTimestamp(ulid(now))).toBe(now);
  });

  describe("形式の検証", () => {
    it("正しい ULID を受け入れる", () => {
      expect(isUlid(ulid())).toBe(true);
    });

    it("★それらしいが不正な ID を弾く★", () => {
      // 手で書いたテスト用 ID にありがちな失敗
      expect(isUlid("01K2TESTMEDIA0000000000000")).toBe(false); // 25文字
      expect(isUlid("01K2TESTLISTING00000000000")).toBe(false); // I を含む
      expect(isUlid("01k2tavvvvvvvvvvvvvvvvvvvv")).toBe(false); // 小文字
      expect(isUlid("")).toBe(false);
      expect(isUlid(null)).toBe(false);
      expect(isUlid(123)).toBe(false);
      expect(isUlid(`${ulid()}A`)).toBe(false); // 27文字
    });

    it("不正な ID からは時刻を読めない", () => {
      expect(ulidTimestamp("not-a-ulid")).toBeNull();
    });
  });
});
