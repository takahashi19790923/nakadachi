import { describe, expect, it } from "vitest";

import {
  CATEGORIES,
  CATEGORY_SLUGS,
  isKindOfCategory,
} from "~/domain/categories";
import {
  containsContactInfo,
  looksLikeStreetAddress,
  safeRedirectPath,
} from "~/domain/validation/common";
import { listingInputSchema } from "~/domain/validation/listing";
import { parseSearchParams } from "~/domain/validation/interaction";

/** 各カテゴリの最小限の入力 */
function baseInput(overrides: Record<string, unknown>) {
  return {
    title: "使わなくなった脚立をお譲りします",
    body: "3年ほど前に購入したものです。目立った傷はありません。取りに来られる方に限ります。",
    prefectureCode: "13",
    cityCode: "13107",
    durationDays: 30,
    ...overrides,
  };
}

describe("カテゴリと投稿種別", () => {
  it("5つのカテゴリがある", () => {
    expect(CATEGORY_SLUGS).toHaveLength(5);
    expect(CATEGORY_SLUGS).toEqual([
      "sell-buy",
      "giveaway",
      "rental",
      "help",
      "job",
    ]);
  });

  it("お仕事の雇用形態はアルバイトと正社員の2つ", () => {
    expect(CATEGORIES.job.kinds).toEqual(["part_time", "full_time"]);
  });

  it("★他カテゴリの投稿種別を混ぜられない★", () => {
    expect(isKindOfCategory("sell-buy", "sell")).toBe(true);
    expect(isKindOfCategory("sell-buy", "part_time")).toBe(false);
    expect(isKindOfCategory("job", "sell")).toBe(false);
    expect(isKindOfCategory("rental", "tool")).toBe(true);
    expect(isKindOfCategory("rental", "give")).toBe(false);
  });
});

describe("投稿の入力検証", () => {
  it("売ります：正しい入力を受け入れる", () => {
    const result = listingInputSchema.safeParse(
      baseInput({
        categorySlug: "sell-buy",
        kind: "sell",
        priceType: "fixed",
        priceJpy: "3000",
        itemCondition: "good",
        handoverMethod: "pickup",
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.priceJpy).toBe(3000);
      expect(result.data.priceUnit).toBe("once");
    }
  });

  it("★固定価格なのに金額が空なら落とす★", () => {
    const result = listingInputSchema.safeParse(
      baseInput({
        categorySlug: "sell-buy",
        kind: "sell",
        priceType: "fixed",
        priceJpy: "",
        itemCondition: "good",
        handoverMethod: "pickup",
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("priceJpy"))).toBe(
        true,
      );
    }
  });

  it("相談なら金額が空でも通る", () => {
    const result = listingInputSchema.safeParse(
      baseInput({
        categorySlug: "sell-buy",
        kind: "buy",
        priceType: "negotiable",
        priceJpy: "",
        itemCondition: "good",
        handoverMethod: "either",
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.priceJpy).toBeNull();
  });

  it("無料なら金額を見ない", () => {
    const result = listingInputSchema.safeParse(
      baseInput({
        categorySlug: "giveaway",
        kind: "give",
        priceType: "free",
        itemCondition: "fair",
        handoverMethod: "pickup",
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.priceJpy).toBeNull();
  });

  it("★カテゴリに無い投稿種別は落とす★", () => {
    const result = listingInputSchema.safeParse(
      baseInput({
        categorySlug: "sell-buy",
        kind: "full_time",
        priceType: "fixed",
        priceJpy: "1000",
        itemCondition: "good",
        handoverMethod: "pickup",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("貸します：デポジットありなのに条件が空なら落とす", () => {
    const result = listingInputSchema.safeParse(
      baseInput({
        categorySlug: "rental",
        kind: "tool",
        priceType: "fixed",
        priceJpy: "500",
        priceUnit: "day",
        itemCondition: "good",
        depositRequired: "on",
        depositNote: "",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("貸します：終了日が開始日より前なら落とす", () => {
    const result = listingInputSchema.safeParse(
      baseInput({
        categorySlug: "rental",
        kind: "tool",
        priceType: "fixed",
        priceJpy: "500",
        priceUnit: "day",
        itemCondition: "good",
        availableFrom: "2026-09-01",
        availableTo: "2026-08-01",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("お仕事：会社名と勤務時間が必須", () => {
    const withoutCompany = listingInputSchema.safeParse(
      baseInput({
        categorySlug: "job",
        kind: "part_time",
        priceType: "fixed",
        priceJpy: "1200",
        priceUnit: "hour",
        workHours: "9:00〜17:00",
      }),
    );
    expect(withoutCompany.success).toBe(false);

    const complete = listingInputSchema.safeParse(
      baseInput({
        categorySlug: "job",
        kind: "part_time",
        priceType: "fixed",
        priceJpy: "1200",
        priceUnit: "hour",
        workHours: "9:00〜17:00",
        companyName: "なかだち商店",
      }),
    );
    expect(complete.success).toBe(true);
  });

  it("お仕事：給与の上限が下限より小さければ落とす", () => {
    const result = listingInputSchema.safeParse(
      baseInput({
        categorySlug: "job",
        kind: "full_time",
        priceType: "fixed",
        priceJpy: "3000000",
        salaryMaxJpy: "2000000",
        priceUnit: "year",
        workHours: "9:00〜18:00",
        companyName: "なかだち商店",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("★金額に文字を混ぜられない★", () => {
    const result = listingInputSchema.safeParse(
      baseInput({
        categorySlug: "sell-buy",
        kind: "sell",
        priceType: "fixed",
        priceJpy: "1000円",
        itemCondition: "good",
        handoverMethod: "pickup",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("桁の打ち間違い（1億超）を落とす", () => {
    const result = listingInputSchema.safeParse(
      baseInput({
        categorySlug: "sell-buy",
        kind: "sell",
        priceType: "fixed",
        priceJpy: "999999999",
        itemCondition: "good",
        handoverMethod: "pickup",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("掲載期間は決められた選択肢だけ", () => {
    const invalid = listingInputSchema.safeParse(
      baseInput({
        categorySlug: "sell-buy",
        kind: "sell",
        priceType: "free",
        itemCondition: "good",
        handoverMethod: "pickup",
        durationDays: 365,
      }),
    );
    expect(invalid.success).toBe(false);
  });

  it("★番地らしき地域メモを落とす★", () => {
    const result = listingInputSchema.safeParse(
      baseInput({
        categorySlug: "sell-buy",
        kind: "sell",
        priceType: "free",
        itemCondition: "good",
        handoverMethod: "pickup",
        areaNote: "八広6-13-7",
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe("個人情報らしき文字列の検出", () => {
  it("電話番号を見つける", () => {
    expect(containsContactInfo("連絡先は090-1234-5678です")).toBe(true);
    expect(containsContactInfo("０９０１２３４５６７８")).toBe(true);
  });

  it("メールアドレスを見つける", () => {
    expect(containsContactInfo("foo@example.com まで")).toBe(true);
  });

  it("普通の文章では反応しない", () => {
    expect(containsContactInfo("3年ほど使いました。状態は良好です。")).toBe(false);
    expect(containsContactInfo("2026年8月に購入")).toBe(false);
  });

  it("番地らしき並びを見つける", () => {
    expect(looksLikeStreetAddress("1-2-3")).toBe(true);
    expect(looksLikeStreetAddress("八広6丁目")).toBe(true);
    expect(looksLikeStreetAddress("13番7号")).toBe(true);
    expect(looksLikeStreetAddress("押上駅の近く")).toBe(false);
  });
});

describe("戻り先の検証（オープンリダイレクト対策）", () => {
  it("自分のサイト内のパスは通す", () => {
    expect(safeRedirectPath("/mypage/drafts")).toBe("/mypage/drafts");
    expect(safeRedirectPath("/search?q=test")).toBe("/search?q=test");
  });

  it("★外部への転送を許さない★", () => {
    expect(safeRedirectPath("https://evil.example")).toBe("/mypage");
    expect(safeRedirectPath("//evil.example")).toBe("/mypage");
    expect(safeRedirectPath("http://evil.example")).toBe("/mypage");
    // バックスラッシュを / と解釈するブラウザ向け
    expect(safeRedirectPath("/\\evil.example")).toBe("/mypage");
    expect(safeRedirectPath("javascript:alert(1)")).toBe("/mypage");
  });

  it("壊れた値は既定へ落とす", () => {
    expect(safeRedirectPath(null)).toBe("/mypage");
    expect(safeRedirectPath(undefined)).toBe("/mypage");
    expect(safeRedirectPath(123)).toBe("/mypage");
    expect(safeRedirectPath("")).toBe("/mypage");
  });
});

describe("検索条件の読み取り", () => {
  it("既定値へ落とす", () => {
    const parsed = parseSearchParams(new URL("https://example.test/search"));
    expect(parsed.sort).toBe("newest");
    expect(parsed.page).toBe(1);
  });

  it("★壊れた値で例外にしない（黙って既定へ落とす）★", () => {
    const url = new URL(
      "https://example.test/search?page=abc&sort=weird&min=-5&pref=xx&category=nope",
    );
    const parsed = parseSearchParams(url);
    expect(parsed.page).toBe(1);
    expect(parsed.sort).toBe("newest");
    expect(parsed.min).toBeUndefined();
    expect(parsed.pref).toBeUndefined();
    expect(parsed.category).toBeUndefined();
  });

  it("深すぎるページ番号を切る", () => {
    const parsed = parseSearchParams(
      new URL("https://example.test/search?page=99999"),
    );
    expect(parsed.page).toBe(1);
  });
});

/**
 * ★検証エラーの文言が英語のまま利用者へ出ないこと。★
 *
 * zod の既定文言は英語（"Invalid input"）で、個々の項目に文言を
 * 書き忘れるとそのまま画面に出る。実際に投稿フォームで出た
 * （2026-08-16、投稿種別を選ばずに送信したとき）。
 * 全部の項目に文言を書いて回るのは抜けるので、既定を日本語に寄せて
 * ここで見張る。
 */
describe("★検証エラーの文言に英語を出さない★", () => {
  /** 日本語（ひらがな・カタカナ・漢字）を1文字以上含むか */
  function hasJapanese(message: string): boolean {
    return /[\u3040-\u30ff\u4e00-\u9fff]/.test(message);
  }

  it("必須項目が空でも英語にならない", () => {
    // 何も入っていない入力。全項目ぶんのエラーが出る。
    const result = listingInputSchema.safeParse({ categorySlug: "sell-buy" });
    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.issues.length).toBeGreaterThan(0);
    for (const issue of result.error.issues) {
      expect(
        hasJapanese(issue.message),
        `英語の文言が残っている: ${issue.path.join(".")} → ${issue.message}`,
      ).toBe(true);
    }
  });

  it("選ぶ項目は「選択してください」、入力欄は「入力してください」", () => {
    const result = listingInputSchema.safeParse({ categorySlug: "sell-buy" });
    if (result.success) throw new Error("入力が通ってしまった");

    const messageOf = (field: string) =>
      result.error.issues.find((i) => i.path[0] === field)?.message;

    // ラジオ・セレクト
    expect(messageOf("kind")).toBe("選択してください");
    expect(messageOf("itemCondition")).toBe("選択してください");
    expect(messageOf("handoverMethod")).toBe("選択してください");
    // 入力欄
    expect(messageOf("title")).toBe("入力してください");
    expect(messageOf("body")).toBe("入力してください");
  });

  it("各スキーマに書いた文言のほうが優先される", () => {
    // 掲載期間は listing.ts が自前の文言を持っている。
    const result = listingInputSchema.safeParse(
      baseInput({ categorySlug: "sell-buy", kind: "sell", durationDays: 9999 }),
    );
    if (result.success) throw new Error("入力が通ってしまった");
    const message = result.error.issues.find(
      (i) => i.path[0] === "durationDays",
    )?.message;
    expect(message).toBe("掲載期間の指定が不正です");
  });
});
