import { and, desc, eq, isNull, sql } from "drizzle-orm";

import {
  bannedWords,
  listings,
  messages,
  reports,
  users,
} from "~/db/schema/index.ts";
import { ulid } from "~/domain/ulid.ts";
import type { Db } from "../db.server.ts";

/**
 * 禁止ワードと通報。
 *
 * ★機械的な語句の照合だけで守れるとは考えないこと。★ 日本語は表記ゆれが多く、
 * 記号や伏せ字を挟まれれば簡単にすり抜ける。通報と管理者の目視と併用する
 * 前提の、最初の網でしかない。
 */

/** 照合用に文字を寄せる。全角英数・カタカナ・記号の差を吸収する */
export function normalizeForMatching(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    // 伏せ字に使われやすい記号と空白を落とす
    .replace(/[\s・.,\-_*＊●○◯~〜"'`|/\\]/g, "");
}

/**
 * severity=block の語を含むか。含むなら最初に見つかった語を返す。
 *
 * 語数が増えても1回の問い合わせで済むよう、照合は DB 側で行う。
 * アプリ側で全件取得して回すと、語が増えるほど転送量が増える。
 */
export async function findBlockingWord(
  db: Db,
  text: string,
): Promise<string | null> {
  const normalized = normalizeForMatching(text);
  if (normalized === "") return null;

  const rows = await db
    .select({ word: bannedWords.word })
    .from(bannedWords)
    .where(
      and(
        eq(bannedWords.severity, "block"),
        sql`position(lower(${bannedWords.word}) in ${normalized}) > 0`,
      ),
    )
    .limit(1);

  return rows[0]?.word ?? null;
}

/** severity=flag の語。投稿は通すが管理者の確認待ちに入れる */
export async function findFlaggedWords(
  db: Db,
  text: string,
): Promise<string[]> {
  const normalized = normalizeForMatching(text);
  if (normalized === "") return [];

  const rows = await db
    .select({ word: bannedWords.word })
    .from(bannedWords)
    .where(
      and(
        eq(bannedWords.severity, "flag"),
        sql`position(lower(${bannedWords.word}) in ${normalized}) > 0`,
      ),
    )
    .limit(20);

  return rows.map((row) => row.word);
}

export async function listBannedWords(db: Db) {
  return db
    .select({
      id: bannedWords.id,
      word: bannedWords.word,
      severity: bannedWords.severity,
      note: bannedWords.note,
      createdAt: bannedWords.createdAt,
    })
    .from(bannedWords)
    .orderBy(desc(bannedWords.createdAt))
    .limit(500);
}

export async function addBannedWord(
  db: Db,
  options: {
    word: string;
    severity: "block" | "flag";
    note?: string;
    createdBy: string;
  },
): Promise<void> {
  await db
    .insert(bannedWords)
    .values({
      id: ulid(),
      word: normalizeForMatching(options.word),
      severity: options.severity,
      note: options.note ?? null,
      createdBy: options.createdBy,
    })
    // 同じ語を二重に登録しても失敗させない（管理画面で連打されうる）。
    .onConflictDoNothing({ target: bannedWords.word });
}

export async function removeBannedWord(db: Db, id: string): Promise<void> {
  await db.delete(bannedWords).where(eq(bannedWords.id, id));
}

// ── 通報 ──────────────────────────────────────────────────────────

export type ReportTarget =
  | { type: "listing"; id: string }
  | { type: "message"; id: string }
  | { type: "user"; id: string };

export async function createReport(
  db: Db,
  options: {
    reporterId: string;
    target: ReportTarget;
    reason: string;
    detail: string;
  },
): Promise<{ created: boolean }> {
  const values = {
    id: ulid(),
    reporterId: options.reporterId,
    targetType: options.target.type,
    targetListingId: options.target.type === "listing" ? options.target.id : null,
    targetMessageId: options.target.type === "message" ? options.target.id : null,
    targetUserId: options.target.type === "user" ? options.target.id : null,
    reason: options.reason as "other",
    detail: options.detail || null,
  };

  // 同じ人が同じ投稿を繰り返し通報しても行は増えない（部分一意索引）。
  const result = await db.insert(reports).values(values).onConflictDoNothing();
  return { created: (result.rowCount ?? 0) > 0 };
}

export async function listReportsByReporter(db: Db, reporterId: string) {
  return db
    .select({
      id: reports.id,
      targetType: reports.targetType,
      targetListingId: reports.targetListingId,
      reason: reports.reason,
      status: reports.status,
      createdAt: reports.createdAt,
      resolvedAt: reports.resolvedAt,
    })
    .from(reports)
    .where(eq(reports.reporterId, reporterId))
    .orderBy(desc(reports.createdAt))
    .limit(100);
}

export async function listReportsForAdmin(
  db: Db,
  status?: "open" | "reviewing" | "actioned" | "dismissed",
) {
  const conditions = status ? [eq(reports.status, status)] : [];
  return db
    .select({
      id: reports.id,
      targetType: reports.targetType,
      targetListingId: reports.targetListingId,
      targetMessageId: reports.targetMessageId,
      targetUserId: reports.targetUserId,
      reason: reports.reason,
      detail: reports.detail,
      status: reports.status,
      createdAt: reports.createdAt,
      listingTitle: listings.title,
      listingStatus: listings.status,
    })
    .from(reports)
    .leftJoin(listings, eq(listings.id, reports.targetListingId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(reports.createdAt))
    .limit(200);
}

/**
 * 通報の対応状態を記録する。
 *
 * ★該当が無ければ false を返す。★ 呼び出し側は必ず確かめること。
 * 捨てると「対応しました」と表示され管理操作の記録も残るのに、通報は
 * 未対応のまま残る。ダッシュボードの件数だけが減ったように見えて、
 * ★対応漏れが一番気づきにくい形で隠れる。★
 */
export async function resolveReport(
  db: Db,
  options: {
    reportId: string;
    status: "reviewing" | "actioned" | "dismissed";
    adminId: string;
    note: string;
  },
): Promise<boolean> {
  const result = await db
    .update(reports)
    .set({
      status: options.status,
      resolvedAt: options.status === "reviewing" ? null : new Date(),
      resolvedBy: options.adminId,
      resolutionNote: options.note,
      updatedAt: new Date(),
    })
    .where(eq(reports.id, options.reportId));
  return (result.rowCount ?? 0) > 0;
}

/** 未対応の通報件数。管理ダッシュボードのバッジに使う */
export async function countOpenReports(db: Db): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reports)
    .where(eq(reports.status, "open"));
  return rows[0]?.count ?? 0;
}

/** 通報されたメッセージの本文。管理者が対応するときだけ引く */
export async function getReportedMessage(db: Db, messageId: string) {
  const rows = await db
    .select({
      id: messages.id,
      body: messages.body,
      senderId: messages.senderId,
      threadId: messages.threadId,
      createdAt: messages.createdAt,
      senderStatus: users.status,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderId))
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}
