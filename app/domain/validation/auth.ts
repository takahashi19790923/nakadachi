import { z } from "zod";

// 検証エラーの既定文言を日本語にする。消すと画面に "Invalid input" と出る。
import "./zod-setup";

import { emailSchema, otpSchema, trimmedString } from "./common";

/** ログインメールの送信要求 */
export const loginRequestSchema = z.object({
  email: emailSchema,
  // Turnstile のトークンは verifyTurnstile 側で検証する。ここでは形だけ。
  turnstileToken: z.string().min(1).max(2048),
});

/** OTP による確認 */
export const loginVerifySchema = z.object({
  email: emailSchema,
  otp: otpSchema,
});

/** マジックリンク */
export const loginLinkSchema = z.object({
  token: z.string().min(20).max(200),
});

export const profileUpdateSchema = z.object({
  displayName: trimmedString.pipe(
    z
      .string()
      .min(1, "表示名を入力してください")
      .max(40, "40文字以内で入力してください"),
  ),
  bio: trimmedString.pipe(z.string().max(400, "400文字以内で入力してください")),
  prefectureCode: z.string().max(8).optional(),
  cityCode: z.string().max(8).optional(),
  notifyOnMessage: z.coerce.boolean().optional(),
  notifyOnExpiry: z.coerce.boolean().optional(),
});

/**
 * 退会。
 * ★確認の文字列を打たせる。★ 誤操作で消えないようにするため。
 */
export const accountDeletionSchema = z.object({
  confirmation: z.literal("退会します", {
    message: "「退会します」と入力してください",
  }),
});

export const adminGateSchema = z.object({
  user: z.string().min(1).max(200),
  pass: z.string().min(1).max(400),
});
