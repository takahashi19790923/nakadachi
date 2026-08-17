import { z } from "zod";

// 検証エラーの既定文言を日本語にする。消すと画面に "Invalid input" と出る。
import "./zod-setup";

import {
  CATEGORIES,
  CATEGORY_SLUGS,
  GIVEAWAY_KINDS,
  HANDOVER_METHODS,
  HELP_KINDS,
  ITEM_CONDITIONS,
  JOB_KINDS,
  PRICE_UNITS,
  RENTAL_KINDS,
  SELL_BUY_KINDS,
} from "../categories";
import { LISTING_DURATION_DAYS_CHOICES } from "../pricing";
import {
  areaNoteSchema,
  jpyAmountSchema,
  locationCodeSchema,
  optionalText,
  trimmedString,
} from "./common";

/**
 * 投稿の入力検証。
 *
 * ★カテゴリごとに別のスキーマを持つ。★ 1つの巨大なスキーマに任意項目を
 * 並べると、「求人なのに商品状態が入っている」「貸出なのに雇用形態がある」
 * といった組み合わせが通ってしまう。カテゴリで分岐する判別可能な合併にして、
 * 想定外の項目は落とす。
 *
 * 選択肢の出どころは app/domain/categories.ts の1か所だけ。ここに値を
 * 書き写さない（増やしたときに片方だけ直す事故を防ぐ）。
 */

/** 金額の上限。求人の年収を考えて1億円まで。桁の打ち間違いはここで止まる */
const MAX_AMOUNT_JPY = 100_000_000;

const baseFields = {
  title: trimmedString.pipe(
    z
      .string()
      .min(4, "タイトルは4文字以上で入力してください")
      .max(80, "タイトルは80文字以内で入力してください"),
  ),
  body: trimmedString.pipe(
    z
      .string()
      .min(10, "説明は10文字以上で入力してください")
      .max(4000, "説明は4000文字以内で入力してください"),
  ),
  prefectureCode: locationCodeSchema,
  cityCode: locationCodeSchema,
  areaNote: areaNoteSchema.optional(),
  /*
   * 任意にしてある理由: 公開中の投稿の編集画面は期間欄を出さない
   * （公開後は変えられない）ので、送られてこない。必須のままだと
   * ★公開中の投稿は一切編集できない★（2026-08-17 の点検で発覚。
   * 誤字を直そうとすると開発者向けの検証エラーが出て保存できなかった）。
   * 省略時は保存側が既定値を使い、公開中なら保存済みの値を保つ。
   */
  durationDays: z.coerce
    .number()
    .int()
    .refine(
      (value) =>
        (LISTING_DURATION_DAYS_CHOICES as readonly number[]).includes(value),
      { message: "掲載期間の指定が不正です" },
    )
    .optional(),
};

/** 価格。無料なら金額欄を見ない。相談なら金額は任意 */
const priceFields = {
  priceType: z.enum(["fixed", "negotiable", "free"]),
  priceJpy: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => (value === undefined || value === "" ? undefined : value)),
  priceUnit: z.enum(PRICE_UNITS).optional(),
};

/**
 * 価格の整合を確かめる。
 * 「固定価格を選んだのに金額が空」を通すと、一覧に「価格未設定」が並ぶ。
 */
function refinePrice(
  data: { priceType: string; priceJpy?: unknown },
  ctx: z.RefinementCtx,
): number | null {
  if (data.priceType === "free") return null;

  const raw = data.priceJpy;
  if (raw === undefined || raw === "") {
    if (data.priceType === "fixed") {
      ctx.addIssue({
        code: "custom",
        path: ["priceJpy"],
        message: "金額を入力してください",
      });
      return null;
    }
    // 相談は金額なしを許す
    return null;
  }

  const parsed = jpyAmountSchema(MAX_AMOUNT_JPY).safeParse(raw);
  if (!parsed.success) {
    ctx.addIssue({
      code: "custom",
      path: ["priceJpy"],
      message: parsed.error.issues[0]?.message ?? "金額をご確認ください",
    });
    return null;
  }
  return parsed.data;
}

// ── カテゴリごと ──────────────────────────────────────────────────

const sellBuySchema = z
  .object({
    categorySlug: z.literal("sell-buy"),
    kind: z.enum(SELL_BUY_KINDS),
    ...baseFields,
    ...priceFields,
    itemCondition: z.enum(ITEM_CONDITIONS),
    handoverMethod: z.enum(HANDOVER_METHODS),
  })
  .transform((data, ctx) => ({
    ...data,
    priceUnit: "once" as const,
    priceJpy: refinePrice(data, ctx),
  }));

const giveawaySchema = z
  .object({
    categorySlug: z.literal("giveaway"),
    kind: z.enum(GIVEAWAY_KINDS),
    ...baseFields,
    // 「無料／有料」だけ。相談は使わない
    priceType: z.enum(["free", "fixed"]),
    priceJpy: priceFields.priceJpy,
    itemCondition: z.enum(ITEM_CONDITIONS),
    handoverMethod: z.enum(HANDOVER_METHODS),
  })
  .transform((data, ctx) => ({
    ...data,
    priceUnit: "once" as const,
    priceJpy: refinePrice(data, ctx),
  }));

const rentalSchema = z
  .object({
    categorySlug: z.literal("rental"),
    kind: z.enum(RENTAL_KINDS),
    ...baseFields,
    ...priceFields,
    priceUnit: z.enum(["hour", "day", "week", "month", "other"]),
    itemCondition: z.enum(ITEM_CONDITIONS),
    /**
     * デポジットの有無と条件文。
     * ★MVP ではサービスが預かり金を扱わない。★ ここは当事者間の取り決めを
     * 説明として表示するだけで、決済も保管も行わない。
     */
    depositRequired: z
      .union([z.literal("on"), z.literal("true"), z.literal("false"), z.boolean()])
      .optional()
      .transform((value) => value === "on" || value === "true" || value === true),
    depositNote: optionalText(200),
    availableFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "日付の形式が不正です")
      .optional()
      .or(z.literal("").transform(() => undefined)),
    availableTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "日付の形式が不正です")
      .optional()
      .or(z.literal("").transform(() => undefined)),
    rentalTerms: optionalText(500),
  })
  .transform((data, ctx) => {
    if (
      data.availableFrom &&
      data.availableTo &&
      data.availableFrom > data.availableTo
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["availableTo"],
        message: "終了日は開始日より後にしてください",
      });
    }
    if (data.depositRequired && !data.depositNote) {
      ctx.addIssue({
        code: "custom",
        path: ["depositNote"],
        message:
          "デポジットの金額と返却条件を記載してください（当サービスは預かり金を扱いません）",
      });
    }
    return { ...data, priceJpy: refinePrice(data, ctx) };
  });

const helpSchema = z
  .object({
    categorySlug: z.literal("help"),
    kind: z.enum(HELP_KINDS),
    ...baseFields,
    ...priceFields,
    priceUnit: z.enum(["once", "hour", "day", "other"]),
    serviceContent: trimmedString.pipe(
      z
        .string()
        .min(5, "提供内容を入力してください")
        .max(500, "500文字以内で入力してください"),
    ),
    availabilityNote: optionalText(200),
  })
  .transform((data, ctx) => ({ ...data, priceJpy: refinePrice(data, ctx) }));

const jobSchema = z
  .object({
    categorySlug: z.literal("job"),
    kind: z.enum(JOB_KINDS),
    ...baseFields,
    // 求人は必ず金額で示す。「相談」「無料」を使わない
    priceType: z.literal("fixed"),
    priceJpy: priceFields.priceJpy,
    priceUnit: z.enum(["hour", "day", "month", "year"]),
    salaryMaxJpy: priceFields.priceJpy,
    workLocationNote: optionalText(120),
    workHours: trimmedString.pipe(
      z
        .string()
        .min(1, "勤務時間を入力してください")
        .max(200, "200文字以内で入力してください"),
    ),
    qualifications: optionalText(500),
    benefits: optionalText(500),
    companyName: trimmedString.pipe(
      z
        .string()
        .min(1, "会社名または事業者名を入力してください")
        .max(80, "80文字以内で入力してください"),
    ),
  })
  .transform((data, ctx) => {
    const min = refinePrice(data, ctx);
    let max: number | null = null;
    if (data.salaryMaxJpy !== undefined && data.salaryMaxJpy !== "") {
      const parsed = jpyAmountSchema(MAX_AMOUNT_JPY).safeParse(data.salaryMaxJpy);
      if (!parsed.success) {
        ctx.addIssue({
          code: "custom",
          path: ["salaryMaxJpy"],
          message: "給与の上限をご確認ください",
        });
      } else {
        max = parsed.data;
        if (min !== null && max < min) {
          ctx.addIssue({
            code: "custom",
            path: ["salaryMaxJpy"],
            message: "上限は下限以上にしてください",
          });
        }
      }
    }
    return { ...data, priceJpy: min, salaryMaxJpy: max };
  });

/**
 * 投稿の入力。カテゴリで分岐する。
 * 未知の categorySlug はここで落ちる。
 */
export const listingInputSchema = z.discriminatedUnion("categorySlug", [
  sellBuySchema,
  giveawaySchema,
  rentalSchema,
  helpSchema,
  jobSchema,
]);

export type ListingInput = z.infer<typeof listingInputSchema>;

/**
 * kind がそのカテゴリのものかを念のため確かめる。
 * スキーマ側でも絞っているが、カテゴリを増やしたときの取りこぼしを防ぐ二重化。
 */
export function assertKindMatchesCategory(input: ListingInput): boolean {
  const definition = CATEGORIES[input.categorySlug];
  return (definition.kinds as readonly string[]).includes(input.kind);
}

export const categorySlugSchema = z.enum(CATEGORY_SLUGS);

/** 掲載終了・削除などの操作 */
export const listingActionSchema = z.object({
  intent: z.enum(["close", "delete", "restore"]),
});
