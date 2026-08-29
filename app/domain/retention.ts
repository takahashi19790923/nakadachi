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
 * 一度も公開されなかった下書き。
 *
 * ★これまで誰も消していなかった。★ 掲載は「下書き → 決済 → 公開」で、
 * 決済まで進まなかったものは draft のまま永久に残る。写真も R2 に
 * 残り続ける（1枚あたりの上限が大きいので、ここがいちばん費用に効く）。
 * 期限切れの掃除は「終わった掲載」（closed / expired / rejected …）
 * しか見ておらず、draft は「終わっていない」ので対象外だった。
 *
 * 180日。書きかけを保存したまま数か月あとに戻ってくる人がいるので、
 * 短くしすぎない。★公開されたことのあるものは対象にしない★
 * （published_at が入っていれば、いまが draft でも別の話）。
 */
export const ABANDONED_DRAFT_RETENTION_DAYS = 180;

/**
 * 終わった掲載とみなす状態。
 *
 * ★suspended は入れない。★ 返金・チャージバック・管理者の停止で止めた
 * ものが入る。係争中の内容を先に消すと、あとから経緯を追えなくなる。
 * 消したい場合は管理画面から deleted にする（そこから180日で消える）。
 */
/**
 * ある時刻からの経過日数。
 *
 * ★now を必ず渡せるようにする。★ 渡せないと、検査が実行した日に
 * 依存して落ちるようになる（境界の1日ぶんが日替わりでずれる）。
 */
export function daysSince(at: Date | string, now: Date): number {
  const from = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(from.getTime())) return 0;
  return Math.floor((now.getTime() - from.getTime()) / 86_400_000);
}

/**
 * 停止したままこれを過ぎたら、管理画面で目に付くようにする日数。
 *
 * ★自動削除はしない。★ 係争が長引く案件を勝手に消さないため。
 * 代わりに「対応は終わっていませんか」と人へ出す。
 *
 * 90日にしているのは、終わった掲載の写真が消える節目と同じにするため。
 * 対応が終わっているなら管理画面から削除でき（そこから180日で本文も消える）、
 * 終わっていないなら何もしなくてよい。
 */
export const SUSPENDED_REVIEW_DAYS = 90;

export const ENDED_LISTING_STATUSES = [
  "closed",
  "expired",
  "deleted",
  "rejected",
] as const satisfies readonly ListingStatus[];

/**
 * 停止したまま放置されていないか。
 *
 * ★停止は自動では消えない。★ 人が「対応が終わった」と判断して削除するまで
 * 残り続ける。判断する人がそれを覚えている前提の運用は成り立たないので、
 * 一定日数を過ぎたものを管理画面に出す。
 */
export function needsSuspendedReview(
  status: ListingStatus,
  endedAt: Date | string | null,
  now: Date,
): boolean {
  if (status !== "suspended") return false;
  if (!endedAt) return true; // 時刻が分からないものは、むしろ古い
  return daysSince(endedAt, now) >= SUSPENDED_REVIEW_DAYS;
}
