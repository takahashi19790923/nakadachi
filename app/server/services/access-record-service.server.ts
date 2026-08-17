import { and, desc, eq, sql } from "drizzle-orm";

import {
  accessRecords,
  ACCESS_RECORD_RETENTION_DAYS,
  type AccessRecordAction,
} from "~/db/schema/index.ts";
import { ulid } from "~/domain/ulid.ts";
import { decryptString, encryptString, hmacSha256Hex } from "../crypto.server.ts";
import type { Db } from "../db.server.ts";
import { requireSecret, type AppEnv } from "../env.server.ts";
import type { Logger } from "../logger.server.ts";
import { clientIp } from "../session.server.ts";

/**
 * 発信者情報の記録と取り出し。
 *
 * ★記録できなくても、利用者の操作は止めない。★
 * 投稿やメッセージの本体は成功しているのに、記録の失敗で全体が巻き戻ると、
 * 利用者から見れば「お金は取られたのに投稿されていない」になる。
 * 失敗はログに残して先へ進む（記録の欠落は運用で検知する）。
 *
 * ★逆に、読み出しは管理者だけに許す。★ 呼び出し側で必ず権限を確かめること。
 * この層は権限を見ない（見る場所を1つに決めてある：guards.server.ts）。
 */

/** 同じ IP を引くための索引。鍵付きなので総当たりでは戻せない */
function ipIndex(key: string, ip: string): Promise<string> {
  return hmacSha256Hex(key, `access-ip:${ip}`);
}

export async function recordAccess(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  request: Request;
  action: AccessRecordAction;
  userId?: string | null;
  targetType?: string;
  targetId?: string;
}): Promise<void> {
  const { db, env, logger, request, action } = options;

  try {
    const ip = clientIp(request);
    if (!ip) {
      // Cloudflare を通っていない（ローカル等）。記録しない。
      return;
    }

    const key = requireSecret(env, "ACCESS_LOG_KEY");
    const expiresAt = new Date(
      Date.now() + ACCESS_RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    await db.insert(accessRecords).values({
      id: ulid(),
      userId: options.userId ?? null,
      action,
      targetType: options.targetType ?? null,
      targetId: options.targetId ?? null,
      ipEncrypted: await encryptString(key, ip),
      ipHmac: await ipIndex(key, ip),
      // ★丸ごとは持たない。★ 端末を絞り込める程度で足りる。
      userAgent: (request.headers.get("user-agent") ?? "").slice(0, 255) || null,
      expiresAt,
    });
  } catch (error) {
    // ★ここで throw しない。★ 上の説明のとおり、本体の操作を巻き戻さない。
    logger.error("failed to record access", error);
  }
}

export interface DisclosureRecord {
  createdAt: Date;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string;
  userAgent: string | null;
}

/**
 * 開示請求・捜査関係事項照会に答えるための取り出し。
 *
 * ★呼ぶ前に必ず管理者であることを確かめること。★
 * ★引いた事実そのものを audit_logs に残すこと。★ 誰がいつ誰の発信者情報を
 * 見たかが残らないと、内部の濫用を後から検証できない。
 */
export async function disclosureForUser(options: {
  db: Db;
  env: AppEnv;
  userId: string;
  limit?: number;
}): Promise<DisclosureRecord[]> {
  const { db, env, userId } = options;
  const key = requireSecret(env, "ACCESS_LOG_KEY");

  const rows = await db
    .select({
      createdAt: accessRecords.createdAt,
      action: accessRecords.action,
      targetType: accessRecords.targetType,
      targetId: accessRecords.targetId,
      ipEncrypted: accessRecords.ipEncrypted,
      userAgent: accessRecords.userAgent,
    })
    .from(accessRecords)
    .where(eq(accessRecords.userId, userId))
    .orderBy(desc(accessRecords.createdAt))
    .limit(options.limit ?? 200);

  return Promise.all(
    rows.map(async (row) => ({
      createdAt: row.createdAt,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      ip: await decryptString(key, row.ipEncrypted),
      userAgent: row.userAgent,
    })),
  );
}

/** 特定の投稿・メッセージ・通報が、どこから行われたか */
export async function disclosureForTarget(options: {
  db: Db;
  env: AppEnv;
  targetType: string;
  targetId: string;
}): Promise<DisclosureRecord[]> {
  const { db, env, targetType, targetId } = options;
  const key = requireSecret(env, "ACCESS_LOG_KEY");

  const rows = await db
    .select({
      createdAt: accessRecords.createdAt,
      action: accessRecords.action,
      targetType: accessRecords.targetType,
      targetId: accessRecords.targetId,
      ipEncrypted: accessRecords.ipEncrypted,
      userAgent: accessRecords.userAgent,
    })
    .from(accessRecords)
    .where(
      and(
        eq(accessRecords.targetType, targetType),
        eq(accessRecords.targetId, targetId),
      ),
    )
    .orderBy(desc(accessRecords.createdAt));

  return Promise.all(
    rows.map(async (row) => ({
      createdAt: row.createdAt,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      ip: await decryptString(key, row.ipEncrypted),
      userAgent: row.userAgent,
    })),
  );
}

/**
 * 保存期間を過ぎたものを消す。定期処理から呼ぶ。
 *
 * ★これを止めないこと。★ 開示のために持っているつもりの表が、
 * 消さないまま溜まると、そのまま漏洩時の被害の大きさになる。
 */
export async function purgeExpiredAccessRecords(
  db: Db,
  limit = 5000,
): Promise<number> {
  /*
   * ★1回の件数を区切り、消した行を返さない。★ 以前は上限無しの DELETE に
   * RETURNING を付けて .length を数えていた。定期処理が数日止まったあとや
   * 利用が伸びたあとの初回で、消す行を全部 Worker へ運んでから数える形になり、
   * 実行時間の上限に当たる。他の掃除（保持期間・セッション・レート制限）は
   * みな rowCount を見ている。ここだけが例外だった。残りは翌日また消える。
   */
  const result = await db.execute(sql`
    delete from access_records
    where id in (
      select id from access_records
      where expires_at < now()
      limit ${limit}
    )
  `);
  return result.rowCount ?? 0;
}
