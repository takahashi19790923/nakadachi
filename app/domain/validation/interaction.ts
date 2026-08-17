import { z } from "zod";

// 検証エラーの既定文言を日本語にする。消すと画面に "Invalid input" と出る。
import "./zod-setup";

import { CATEGORY_SLUGS, LISTING_KINDS } from "../categories";
import { REPORT_REASONS } from "../report-reasons";
import { emailSchema, trimmedString, ulidSchema } from "./common";

/** サイト内メッセージ。HTML は保存も描画もしない */
export const messageSchema = z.object({
  body: trimmedString.pipe(
    z
      .string()
      .min(1, "本文を入力してください")
      .max(2000, "2000文字以内で入力してください"),
  ),
});

// 表示名と値は依存を持たないファイル（../report-reasons）へ移した。
// クライアント側の画面がここを import すると zod ごと引き込むため。
// 既存の import 先を壊さないよう、ここからも再輸出する。
export { REPORT_REASONS, REPORT_REASON_LABEL } from "../report-reasons";

export const reportSchema = z.object({
  reason: z.enum(REPORT_REASONS),
  detail: trimmedString.pipe(
    z.string().max(1000, "1000文字以内で入力してください"),
  ),
});

export const blockSchema = z.object({
  targetUserId: ulidSchema,
  intent: z.enum(["block", "unblock"]),
});

export const contactSchema = z.object({
  email: emailSchema,
  subject: trimmedString.pipe(
    z
      .string()
      .min(1, "件名を入力してください")
      .max(120, "120文字以内で入力してください"),
  ),
  body: trimmedString.pipe(
    z
      .string()
      .min(10, "お問い合わせ内容を10文字以上で入力してください")
      .max(4000, "4000文字以内で入力してください"),
  ),
  turnstileToken: z.string().min(1).max(2048),
});

/**
 * 検索条件。
 *
 * ★すべて任意で、壊れた値は捨てて既定に落とす。★ 検索は誰でも叩ける口なので、
 * 例外を投げるより黙って無視するほうが安全（エラー画面から内部が推測できない）。
 */
export const searchParamsSchema = z.object({
  q: z.string().max(100).optional().catch(undefined),
  category: z.enum(CATEGORY_SLUGS).optional().catch(undefined),
  kind: z.enum(LISTING_KINDS).optional().catch(undefined),
  pref: z
    .string()
    .regex(/^[0-9]{2}$/)
    .optional()
    .catch(undefined),
  city: z
    .string()
    .regex(/^[0-9]{5}$/)
    .optional()
    .catch(undefined),
  min: z.coerce.number().int().min(0).max(100_000_000).optional().catch(undefined),
  max: z.coerce.number().int().min(0).max(100_000_000).optional().catch(undefined),
  sort: z
    .enum(["newest", "price_asc", "price_desc", "expiring"])
    .default("newest")
    .catch("newest"),
  // ページ番号の上限を切る。深いページは索引を使っても重く、意味も薄い。
  page: z.coerce.number().int().min(1).max(200).default(1).catch(1),
});

export type SearchParamsInput = z.infer<typeof searchParamsSchema>;

export function parseSearchParams(url: URL): SearchParamsInput {
  return searchParamsSchema.parse(Object.fromEntries(url.searchParams));
}
