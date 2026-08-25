import { z } from "zod";

// 検証エラーの既定文言を日本語にする。消すと画面に "Invalid input" と出る。
import "./zod-setup";

/**
 * 共通の入力検証。
 *
 * ★すべてサーバー側で通す。★ クライアント側の検証は入力体験のためだけで、
 * 防御としては数えない。フォームを経由しない POST は簡単に作れる。
 */

/**
 * 全角空白も空白として扱い、前後を落としてから長さを見る。
 * 正規表現には文字そのものではなくコードポイント指定で書く
 * （全角空白は見た目で判別できず、意図しない混入に気づけないため）。
 */
export const trimmedString = z
  .string()
  .transform((value) => value.replace(/　/g, " ").trim());

export const emailSchema = trimmedString
  .pipe(
    z
      .string()
      .min(5, "メールアドレスの形式をご確認ください")
      .max(254, "メールアドレスが長すぎます")
      // RFC に完全準拠しようとすると実用にならない。実在確認はメール送信で行う。
      .regex(/^[^\s@]+@[^\s@.]+\.[^\s@]+$/, "メールアドレスの形式をご確認ください"),
  )
  .transform((value) => value.toLowerCase());

export const otpSchema = trimmedString.pipe(
  z
    .string()
    .regex(/^[0-9]{6}$/, "6桁の数字を入力してください"),
);

/** ULID。DB を引く前に形式で弾く */
export const ulidSchema = z
  .string()
  .regex(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/, "不正な識別子です");

/** 総務省の全国地方公共団体コード（都道府県2桁・市区町村5桁） */
export const locationCodeSchema = z
  .string()
  .regex(/^[0-9]{2,6}$/, "地域の指定が不正です");

/**
 * 戻り先の検証。
 *
 * ★絶対URLを受け付けない。★ `next=https://evil.example` を通すと
 * オープンリダイレクトになる。`//evil.example` も「スキーム相対URL」として
 * 外部へ飛ぶので、先頭の `//` も拒否する。
 */
export function safeRedirectPath(
  value: unknown,
  fallback = "/mypage",
): string {
  if (typeof value !== "string" || value === "") return fallback;

  /*
   * ★先にタブと改行を取り除く。★
   *
   * URL の仕様（WHATWG）では、タブ・CR・LF は解釈の前に取り除かれる。
   * ブラウザは Location ヘッダもそう読む。つまり "/<TAB>/evil.com" は
   * 先頭が "/" で "//" でもないので前の検査を素通りし、★ブラウザ側では
   * "//evil.com" になって外部サイトへ飛ぶ。★ タブは HTTP ヘッダの値として
   * 正当な文字なので、ヘッダに載せる時点でも弾かれない
   * （2026-08-19 の公開前監査で実測。CR/LF は Headers が例外にするので 500 になる）。
   *
   * ★このサイトはパスワードを持たない。★ ログイン画面をまねた偽サイトへ
   * 自分のドメインから送り出せると、6桁のコードを取られてそのまま乗っ取られる。
   */
  const cleaned = value.replace(/[\t\n\r]/g, "");
  if (!cleaned.startsWith("/")) return fallback;
  if (cleaned.startsWith("//")) return fallback;
  // バックスラッシュを / と解釈するブラウザがあるため、混在も拒否する。
  if (cleaned.includes("\\")) return fallback;

  /*
   * ★最後はパーサ自身に確かめさせる。★ 文字列の前方一致だけで守ろうとすると、
   * 「仕様上ここで消える文字」を1つ見落とすたびに穴が開く。実在しない
   * オリジンを基準に解決させ、同じオリジンに留まったものだけ通す。
   */
  const base = "https://redirect-check.invalid";
  let resolved: URL;
  try {
    resolved = new URL(cleaned, base);
  } catch {
    return fallback;
  }
  if (resolved.origin !== base) return fallback;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/**
 * 連絡先らしき文字列を含むか。
 *
 * 公開される欄（タイトル・本文・地域メモ）で注意を出すために使う。
 * ★機械的に弾き切れるものではない。★ 「〇〇＠ぐーぐる」のような書き方は
 * 検出できない。あくまで「うっかり」を減らすための補助。
 */
export function containsContactInfo(text: string): boolean {
  const phone = /[0０][0-9０-９][0-9０-９\-‐−ー() （）]{7,}[0-9０-９]/;
  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/;
  return phone.test(text) || email.test(text);
}

/**
 * 番地らしき並びを含むか。
 *
 * プライバシー保護のため、公開する住所の粒度は市区町村までにする。
 * 「1-2-3」「1丁目2番3号」のような並びは受け付けない。
 */
export function looksLikeStreetAddress(text: string): boolean {
  const hyphenated = /[0-9０-９]+[-‐−ー][0-9０-９]+[-‐−ー][0-9０-９]+/;
  const japanese = /[0-9０-９一二三四五六七八九十]+丁目/;
  const banchi = /[0-9０-９]+番[0-9０-９]*号?/;
  return hyphenated.test(text) || japanese.test(text) || banchi.test(text);
}

/** 地域メモ。最寄り駅や受け渡し場所を想定した短い自由入力 */
export const areaNoteSchema = trimmedString
  .pipe(z.string().max(60, "60文字以内で入力してください"))
  .refine((value) => !looksLikeStreetAddress(value), {
    message:
      "番地や部屋番号は公開されます。最寄り駅や「〇〇公園の近く」など、場所が特定されすぎない書き方にしてください",
  });

/** 円単位の整数。小数・負数・非現実的な桁を拒否する */
export function jpyAmountSchema(max: number) {
  return z
    .union([z.string(), z.number()])
    .transform((value) =>
      typeof value === "string" ? value.replace(/[,、\s]/g, "") : String(value),
    )
    .pipe(
      z
        .string()
        .regex(/^[0-9]+$/, "金額は半角数字で入力してください")
        .transform((value) => Number.parseInt(value, 10)),
    )
    .pipe(
      z
        .number()
        .int("金額は整数で入力してください")
        .min(0, "金額は0以上で入力してください")
        .max(max, `金額は${max.toLocaleString("ja-JP")}円以下で入力してください`),
    );
}

/** 空文字を undefined に倒す。任意項目のフォーム値に使う */
export function optionalText(maxLength: number, message?: string) {
  return trimmedString
    .pipe(z.string().max(maxLength, message ?? `${maxLength}文字以内で入力してください`))
    .transform((value) => (value === "" ? undefined : value))
    .optional();
}

/**
 * FormData から文字列の項目を取り出す。
 *
 * ★String() で包まないこと。★ FormData の値はファイルのこともあり、
 * String(File) は "[object File]" になる。意図しない値が検証を通り抜ける
 * 温床になるので、文字列以外は既定値へ落とす。
 */
export function formString(
  formData: FormData,
  name: string,
  fallback = "",
): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : fallback;
}

/** FormData を素直なオブジェクトへ。同名の複数値は配列にする */
export function formDataToObject(formData: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (value instanceof File) continue;
    const existing = out[key];
    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  }
  return out;
}

/**
 * Zod のエラーを、画面の入力欄ごとの文言へ落とす。
 * 内部のパス構造をそのまま出さず、最初の1件だけを見せる。
 */
export function toFieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}
