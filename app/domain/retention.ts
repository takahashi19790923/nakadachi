import type { ListingStatus } from "./listing-status.ts";

/**
 * データの保持期間。
 *
 * ★増え続けるものを放置しない。★ 掲載は1件110円で、期限が来れば終わる。
 * 終わった掲載の本文と写真を持ち続ける理由は無い。R2 の容量は特に、
 * 何もしなければ増える一方になる。
 *
 * ★消してはいけないものを、消してよいものと同じ扱いにしない。★
 * 決済記録は帳簿書類なので税務上の保存義務がかかる。監査ログは
 * 係争や不正の調査に使う。どちらも本文とは寿命が違う。
 */

/** 写真。掲載が終わってからの日数 */
export const IMAGE_RETENTION_DAYS = 90;

/** 掲載の本文・詳細。掲載が終わってからの日数 */
export const LISTING_RETENTION_DAYS = 180;

/** 決済 Webhook のイベント記録。受信からの日数（運用データ） */
export const WEBHOOK_EVENT_RETENTION_DAYS = 90;

/** メール送信ログ。送信からの日数（運用データ） */
export const EMAIL_LOG_RETENTION_DAYS = 90;

/** 対応済みの通報。対応完了からの日数 */
export const REPORT_RETENTION_DAYS = 180;

/**
 * 決済記録。
 *
 * ★7年。★ 110円でも売上取引なので、帳簿書類として保存義務がかかる。
 * 半年で消すと税務調査にも返金の問い合わせにも答えられない。
 * `payments.listing_id` は `on delete set null` なので、
 * 掲載を先に消しても決済記録だけ残せる。
 */
export const PAYMENT_RETENTION_DAYS = 365 * 7;

/**
 * 認証まわりの監査ログ（`auth.*` / `authz.*`）。
 *
 * ★監査ログ全体は消さないが、ここだけは期限を切る。★
 * ログインの失敗は★攻撃者が件数を決められる★（レート制限で頭は
 * 押さえてあるが、IP を変えれば増やせる）。永久保存の表へ無制限に
 * 書けると、こちらの保管費用を攻撃手段にされる。
 *
 * 180日にしているのは、不正アクセスに気づいてから調べ始めるまでの
 * 猶予として実用的な長さだから。管理操作の記録（`admin.*`）と
 * 決済の記録は、これまでどおり消さない。
 */
export const AUTH_AUDIT_RETENTION_DAYS = 180;

/**
 * 終わった掲載とみなす状態。
 *
 * ★suspended は入れない。★ 返金・チャージバック・管理者の停止で止めた
 * ものが入る。係争中の内容を先に消すと、あとから経緯を追えなくなる。
 * 消したい場合は管理画面から deleted にする（そこから180日で消える）。
 */
export const ENDED_LISTING_STATUSES = [
  "closed",
  "expired",
  "deleted",
  "rejected",
] as const satisfies readonly ListingStatus[];
