import { describe, expect, it } from "vitest";

import {
  CURRENCY_IS_ZERO_DECIMAL,
  LISTING_FEE_CURRENCY,
  LISTING_FEE_JPY,
  formatJpy,
  isValidListingFeePayment,
} from "~/domain/pricing";
import { CATEGORY_LIST } from "~/domain/categories";
import { categoryKindLabel } from "~/domain/listing-view";

/**
 * 掲載料。
 *
 * ★この検査が緑であることが、ビジネスルールの土台。★
 * 金額を変えるときは、この期待値と Stripe 側の設定と特商法表記の3つを
 * 同時に直す。どれか1つを忘れると、表示と請求が食い違う。
 */
describe("掲載料", () => {
  it("110円・日本円で固定されている", () => {
    expect(LISTING_FEE_JPY).toBe(110);
    expect(LISTING_FEE_CURRENCY).toBe("jpy");
  });

  it("日本円は最小単位が円そのもの（110 は 110円で、1.10円ではない）", () => {
    expect(CURRENCY_IS_ZERO_DECIMAL).toBe(true);
  });

  it("金額の表示に円を付ける", () => {
    expect(formatJpy(110)).toBe("110円");
    expect(formatJpy(1_000_000)).toBe("1,000,000円");
  });
});

describe("支払われた金額の検証", () => {
  it("110円・jpy なら通す", () => {
    expect(isValidListingFeePayment(110, "jpy")).toBe(true);
    // Stripe は大文字で返すことがある
    expect(isValidListingFeePayment(110, "JPY")).toBe(true);
  });

  it("★金額が違えば公開しない★", () => {
    expect(isValidListingFeePayment(1, "jpy")).toBe(false);
    expect(isValidListingFeePayment(0, "jpy")).toBe(false);
    expect(isValidListingFeePayment(109, "jpy")).toBe(false);
    expect(isValidListingFeePayment(111, "jpy")).toBe(false);
    // 「110円のつもりで 11000 を送った」＝ 通貨の最小単位を取り違えた場合
    expect(isValidListingFeePayment(11_000, "jpy")).toBe(false);
  });

  it("★通貨が違えば公開しない★", () => {
    // 110 という数字は合うが、110ドルは 110円ではない
    expect(isValidListingFeePayment(110, "usd")).toBe(false);
    expect(isValidListingFeePayment(110, "eur")).toBe(false);
  });

  it("欠けている値・壊れた値を通さない", () => {
    expect(isValidListingFeePayment(null, "jpy")).toBe(false);
    expect(isValidListingFeePayment(undefined, "jpy")).toBe(false);
    expect(isValidListingFeePayment(110, null)).toBe(false);
    expect(isValidListingFeePayment(110, undefined)).toBe(false);
    expect(isValidListingFeePayment(110.5, "jpy")).toBe(false);
    expect(isValidListingFeePayment(Number.NaN, "jpy")).toBe(false);
  });
});

describe("カテゴリ・種別の見出し", () => {
  it("★カテゴリ名の「・」と区切りが混ざらない★", () => {
    // 「売ります・買います・売ります」だと、どこまでがカテゴリ名か読めない
    expect(categoryKindLabel("sell-buy", "sell")).toBe("売買／売ります");
    expect(categoryKindLabel("sell-buy", "buy")).toBe("売買／買います");
  });

  it("★種別が1つしかないカテゴリでは種別を出さない★", () => {
    // 「あげます・譲ります・あげます・譲ります」という繰り返しを防ぐ
    expect(categoryKindLabel("giveaway", "give")).toBe("あげます・譲ります");
  });

  it("種別が意味を持つカテゴリでは種別も出す", () => {
    expect(categoryKindLabel("rental", "tool")).toBe("貸します／工具");
    expect(categoryKindLabel("job", "part_time")).toBe("仕事／アルバイト");
    expect(categoryKindLabel("help", "inperson")).toBe("手伝います／対面");
  });

  it("すべての組み合わせで、同じ語が2回出ない", () => {
    for (const category of CATEGORY_LIST) {
      for (const kind of category.kinds) {
        const label = categoryKindLabel(category.slug, kind);
        const parts = label.split("／");
        expect(new Set(parts).size, label).toBe(parts.length);
      }
    }
  });
});
