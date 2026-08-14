/**
 * 掲載料。
 *
 * ★この値がサーバー側の唯一の正。★
 * クライアントから送られた金額は一切信用しない。Stripe の Checkout Session は
 * 必ずこの定数から組み立て、Webhook を受けたときも「支払われた額がこの値と
 * 一致するか」をここと突き合わせて検査する。
 *
 * 環境変数にしていないのは、設定の取り違えで別の金額が請求される事故を
 * 構造的に避けるため。値を変えるときはコードを変更してレビューを通す。
 */
export const LISTING_FEE_JPY = 110;

/** 日本円のみ。Stripe の通貨コードは小文字 */
export const LISTING_FEE_CURRENCY = "jpy";

/**
 * 日本円は最小単位が「円」そのもの（zero-decimal currency）。
 * Stripe へ渡す amount も 110 であって 11000 ではない。
 */
export const CURRENCY_IS_ZERO_DECIMAL = true;

/** 掲載期間の既定と上限（日数） */
export const LISTING_DURATION_DAYS_DEFAULT = 30;
export const LISTING_DURATION_DAYS_CHOICES = [7, 14, 30, 60, 90] as const;
export const LISTING_DURATION_DAYS_MAX = 90;

/** 画面表示用。「110円」以外の料金が発生しないことを明示するために使う */
export function formatJpy(amount: number): string {
  return `${amount.toLocaleString("ja-JP")}円`;
}

/**
 * 支払われた金額と通貨が掲載料として妥当かを判定する。
 *
 * Webhook で「110円以外の決済結果で公開されない」ことを保証する要。
 * 金額・通貨のどちらか一方でも違えば false を返す。
 */
export function isValidListingFeePayment(
  amountTotal: number | null | undefined,
  currency: string | null | undefined,
): boolean {
  if (typeof amountTotal !== "number" || !Number.isInteger(amountTotal)) {
    return false;
  }
  if (amountTotal !== LISTING_FEE_JPY) return false;
  if (typeof currency !== "string") return false;
  return currency.toLowerCase() === LISTING_FEE_CURRENCY;
}
