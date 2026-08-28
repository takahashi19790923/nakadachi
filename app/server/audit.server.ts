import { adminActions, auditLogs } from "~/db/schema/index.ts";
import { ulid } from "~/domain/ulid.ts";
import { hashIp } from "./crypto.server.ts";
import type { Db } from "./db.server.ts";
import { requireSecret, type AppEnv } from "./env.server.ts";
import { clientIp } from "./session.server.ts";

/**
 * 監査ログ。
 *
 * ★個人情報を書かないこと。★ メールアドレス・氏名・IP をそのまま入れると、
 * 退会で本体を消してもログに残り、削除した意味が無くなる。IP は鍵付き
 * ハッシュにしてから入れる。
 *
 * ★失敗させないこと。★ 記録に失敗しても本処理を巻き戻さない。ただし
 * 握りつぶしもしない（ログには残す）。監査の欠落は運用で気づける必要がある。
 */
export async function writeAuditLog(
  db: Db,
  env: AppEnv,
  options: {
    action: string;
    actorId?: string | null;
    actorRole?: string | null;
    targetType?: string;
    targetId?: string;
    request?: Request;
    metadata?: Record<string, string | number>;
  },
): Promise<void> {
  let ipHash: string | null = null;
  const ip = options.request ? clientIp(options.request) : null;
  if (ip) {
    try {
      ipHash = await hashIp(requireSecret(env, "SESSION_SECRET"), ip);
    } catch {
      ipHash = null;
    }
  }

  /*
   * ★列の幅に収まらない値で、本処理を落とさない。★
   *
   * 2026-08-28、ログインの失敗記録に 64文字の HMAC をそのまま渡して
   * target_id（varchar(40)）を溢れさせた。結果、★ログインの «失敗» が
   * 500 になった★ —— 記録のための処理が、記録したかった操作そのものを
   * 壊す形。しかも「拒否」も「サーバーエラー」も利用者から見れば
   * 「入れない」なので、気づくのが遅れる。
   *
   * ここで切る。ID やハッシュは先頭だけでも突き合わせに足りる。
   * 幅は app/db/schema/ops.ts の auditLogs と揃えること。
   */
  const fit = (value: string | null | undefined, max: number): string | null =>
    value == null ? null : value.slice(0, max);

  await db.insert(auditLogs).values({
    id: ulid(),
    actorId: fit(options.actorId, 40),
    actorRole: fit(options.actorRole, 20),
    action: options.action.slice(0, 60),
    targetType: fit(options.targetType, 32),
    targetId: fit(options.targetId, 40),
    ipHash,
    metadata: options.metadata ?? null,
  });
}

/**
 * 管理操作の記録。
 * 理由（reason）を必須にしているのは、あとから判断の当否を検証できるようにするため。
 */
export async function writeAdminAction(
  db: Db,
  options: {
    adminId: string;
    actionType:
      | "listing_suspend"
      | "listing_reject"
      | "listing_restore"
      | "listing_delete"
      | "user_suspend"
      | "user_restore"
      | "payment_refund"
      | "report_resolve"
      | "thread_view"
      | "disclosure_view"
      | "site_flags_change"
      | "banned_word_add"
      | "banned_word_remove";
    targetType: string;
    targetId: string;
    reason: string;
    metadata?: Record<string, string | number>;
    tx?: Db;
  },
): Promise<void> {
  const executor = options.tx ?? db;
  await executor.insert(adminActions).values({
    id: ulid(),
    adminId: options.adminId,
    actionType: options.actionType,
    targetType: options.targetType,
    targetId: options.targetId,
    reason: options.reason,
    metadata: options.metadata ?? null,
  });
}
