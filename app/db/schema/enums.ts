import { pgEnum } from "drizzle-orm/pg-core";

// ★相対パスで書く。★ drizzle-kit はスキーマを自前で束ねるため、
// tsconfig の paths（~/…）を解決しない。エイリアスで書くと
// pnpm db:generate だけが「モジュールが見つからない」で落ちる。
import {
  HANDOVER_METHODS,
  ITEM_CONDITIONS,
  LISTING_KINDS,
  PRICE_TYPES,
  PRICE_UNITS,
} from "../../domain/categories.ts";
import { REPORT_REASONS } from "../../domain/report-reasons.ts";
import { LISTING_STATUSES } from "../../domain/listing-status.ts";

/**
 * PostgreSQL の enum 型。
 *
 * ★TypeScript の定数からそのまま作っている。★
 * 選択肢を増やしたのに DB の制約を直し忘れると、型検査もテストも緑のまま
 * 本番の INSERT だけが落ちる。値の出どころを1つにして構造的に防ぐ。
 * test-integration/schema-enums.test.ts が「DB の enum と TS の定数が
 * 一致すること」を実際の DB に問い合わせて確認する。
 *
 * enum は値の追加はできるが削除・並べ替えができない。将来消える可能性が
 * ある選択肢は enum にせず、参照テーブルにすること。
 */

export const listingStatusEnum = pgEnum("listing_status", LISTING_STATUSES);
export const listingKindEnum = pgEnum("listing_kind", LISTING_KINDS);
export const priceTypeEnum = pgEnum("price_type", PRICE_TYPES);
export const priceUnitEnum = pgEnum("price_unit", PRICE_UNITS);
export const itemConditionEnum = pgEnum("item_condition", ITEM_CONDITIONS);
export const handoverMethodEnum = pgEnum("handover_method", HANDOVER_METHODS);

/** 権限は DB 上の明示的なロールで管理する。画面の出し分けだけで守らない */
export const userRoleEnum = pgEnum("user_role", ["user", "admin"]);
export const userStatusEnum = pgEnum("user_status", [
  "active",
  "suspended",
  "deleted",
]);

export const locationKindEnum = pgEnum("location_kind", [
  "prefecture",
  "city",
]);

/**
 * メール確認トークンの用途。用途をまたいだ使い回しを防ぐ。
 * admin_reauth は管理画面に入るときの第2層（管理者だけの再認証）。
 */
export const verificationPurposeEnum = pgEnum("verification_purpose", [
  "login",
  "email_change",
  "account_deletion",
  "admin_reauth",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "created",
  "pending",
  "succeeded",
  "failed",
  "expired",
  "refunded",
  "partially_refunded",
  "disputed",
]);

export const webhookEventStatusEnum = pgEnum("webhook_event_status", [
  "received",
  "processed",
  "ignored",
  "failed",
]);

export const threadParticipantRoleEnum = pgEnum("thread_participant_role", [
  "owner",
  "inquirer",
]);

export const reportTargetTypeEnum = pgEnum("report_target_type", [
  "listing",
  "message",
  "user",
]);

// 値は domain/report-reasons.ts から。ここだけ手書きだと、理由を足したときに
// TS の enum と DB の enum がずれ、通報の INSERT が本番で落ちる。
export const reportReasonEnum = pgEnum("report_reason", REPORT_REASONS);

export const reportStatusEnum = pgEnum("report_status", [
  "open",
  "reviewing",
  "actioned",
  "dismissed",
]);

export const adminActionTypeEnum = pgEnum("admin_action_type", [
  "listing_suspend",
  "listing_reject",
  "listing_restore",
  "listing_delete",
  "user_suspend",
  "user_restore",
  "payment_refund",
  "report_resolve",
  "thread_view",
  /**
   * 発信者情報（復号できるIPアドレス）を取り出した。
   * ★プライバシーポリシーで「参照した事実は記録に残します」と
   * 約束している当のもの。★
   */
  "disclosure_view",
  /** 運用スイッチ（新規登録・投稿・メッセージの停止）の切り替え */
  "site_flags_change",
  "banned_word_add",
  "banned_word_remove",
]);

export const emailDeliveryStatusEnum = pgEnum("email_delivery_status", [
  "queued",
  "sent",
  "failed",
  "bounced",
  "complained",
  "suppressed",
]);

export const bannedWordSeverityEnum = pgEnum("banned_word_severity", [
  "block",
  "flag",
]);

export const deletionRequestStatusEnum = pgEnum("deletion_request_status", [
  "pending",
  "completed",
  "cancelled",
]);
