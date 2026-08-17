import { DELETION_GRACE_DAYS } from "~/domain/account";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import {
  accountDeletionRequests,
  userProfiles,
  users,
} from "~/db/schema/index.ts";
import { ulid } from "~/domain/ulid.ts";
import { decryptString, encryptString } from "../crypto.server.ts";
import type { Db } from "../db.server.ts";
import { requireSecret, type AppEnv } from "../env.server.ts";

/**
 * 利用者。
 *
 * ★メールアドレスの平文をこの層より外へ出さない。★ 復号するのは
 * メール送信の直前だけ。画面・ログ・監査ログには一切載せない。
 */

export interface UserRecord {
  readonly id: string;
  readonly role: "user" | "admin";
  readonly status: "active" | "suspended" | "deleted";
  readonly emailEncrypted: string;
}

export async function findUserByEmailHmac(
  db: Db,
  emailHmac: string,
): Promise<UserRecord | null> {
  const rows = await db
    .select({
      id: users.id,
      role: users.role,
      status: users.status,
      emailEncrypted: users.emailEncrypted,
    })
    .from(users)
    .where(and(eq(users.emailHmac, emailHmac), isNull(users.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 利用者を作る（初回ログイン時）。
 *
 * 表示名の既定値は「なかだちユーザー」＋ID の末尾。
 * ★ID をそのまま表示名にしない。★ 自動生成の識別子が画面に出ると、
 * 誰の投稿か分からない一覧になる。
 */
export async function createUser(
  db: Db,
  env: AppEnv,
  options: { email: string; emailHmac: string; role?: "user" | "admin" },
): Promise<UserRecord> {
  const encryptionKey = requireSecret(env, "EMAIL_ENCRYPTION_KEY");
  const emailEncrypted = await encryptString(encryptionKey, options.email);
  const id = ulid();

  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id,
      emailEncrypted,
      emailHmac: options.emailHmac,
      role: options.role ?? "user",
    });
    await tx.insert(userProfiles).values({
      userId: id,
      displayName: `なかだちユーザー${id.slice(-4)}`,
    });
  });

  return {
    id,
    role: options.role ?? "user",
    status: "active",
    emailEncrypted,
  };
}

/** メール送信の直前だけ使う。戻り値をログへ出さないこと */
export async function decryptUserEmail(
  env: AppEnv,
  emailEncrypted: string,
): Promise<string> {
  return decryptString(requireSecret(env, "EMAIL_ENCRYPTION_KEY"), emailEncrypted);
}

export async function getProfile(db: Db, userId: string) {
  const rows = await db
    .select({
      userId: userProfiles.userId,
      displayName: userProfiles.displayName,
      bio: userProfiles.bio,
      prefectureCode: userProfiles.prefectureCode,
      cityCode: userProfiles.cityCode,
      notifyOnMessage: userProfiles.notifyOnMessage,
      notifyOnExpiry: userProfiles.notifyOnExpiry,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

/** 投稿の詳細に出す、投稿者の公開情報だけ */
export async function getPublicProfile(db: Db, userId: string) {
  const rows = await db
    .select({
      displayName: userProfiles.displayName,
      bio: userProfiles.bio,
      status: users.status,
      joinedAt: users.createdAt,
    })
    .from(userProfiles)
    .innerJoin(users, eq(users.id, userProfiles.userId))
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateProfile(
  db: Db,
  userId: string,
  values: {
    displayName: string;
    bio: string;
    prefectureCode?: string;
    cityCode?: string;
    notifyOnMessage: boolean;
    notifyOnExpiry: boolean;
  },
): Promise<void> {
  await db
    .update(userProfiles)
    .set({
      displayName: values.displayName,
      bio: values.bio || null,
      prefectureCode: values.prefectureCode || null,
      cityCode: values.cityCode || null,
      notifyOnMessage: values.notifyOnMessage,
      notifyOnExpiry: values.notifyOnExpiry,
      updatedAt: new Date(),
    })
    .where(eq(userProfiles.userId, userId));
}

// ── 管理 ──────────────────────────────────────────────────────────

export async function listUsersForAdmin(
  db: Db,
  options: { status?: "active" | "suspended"; limit?: number } = {},
) {
  const conditions = [isNull(users.deletedAt)];
  if (options.status) conditions.push(eq(users.status, options.status));

  return db
    .select({
      id: users.id,
      role: users.role,
      status: users.status,
      displayName: userProfiles.displayName,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
      suspendedReason: users.suspendedReason,
    })
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(and(...conditions))
    .orderBy(desc(users.createdAt))
    .limit(options.limit ?? 200);
}

/**
 * 利用者を停止・復帰させる。
 *
 * ★該当が無ければ false を返す。★ 呼び出し側は必ず確かめること。
 * UPDATE は1行も当たらなくても例外にならない。捨てると「停止しました」と
 * 表示され、監査ログにも残るのに誰も止まっていない状態ができる。
 * ★記録が嘘になるのがいちばん困る。★ あとから経緯を追えなくなる。
 */
export async function setUserStatus(
  db: Db,
  options: {
    userId: string;
    status: "active" | "suspended";
    reason: string | null;
  },
): Promise<boolean> {
  const result = await db
    .update(users)
    .set({
      status: options.status,
      suspendedReason: options.status === "suspended" ? options.reason : null,
      suspendedAt: options.status === "suspended" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, options.userId));
  return (result.rowCount ?? 0) > 0;
}

// ── 退会 ──────────────────────────────────────────────────────────
// 猶予日数は domain/account.ts。退会画面（クライアント側）も参照するため。




export async function requestAccountDeletion(
  db: Db,
  userId: string,
): Promise<{ scheduledPurgeAt: Date }> {
  const scheduledPurgeAt = new Date(
    Date.now() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000,
  );

  await db
    .insert(accountDeletionRequests)
    .values({
      id: ulid(),
      userId,
      scheduledPurgeAt,
    })
    // 部分一意索引により、保留中の依頼は1件だけ。連打しても増えない。
    .onConflictDoNothing();

  return { scheduledPurgeAt };
}

export async function getPendingDeletionRequest(db: Db, userId: string) {
  const rows = await db
    .select({
      id: accountDeletionRequests.id,
      requestedAt: accountDeletionRequests.requestedAt,
      scheduledPurgeAt: accountDeletionRequests.scheduledPurgeAt,
    })
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.userId, userId),
        eq(accountDeletionRequests.status, "pending"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function cancelAccountDeletion(
  db: Db,
  userId: string,
): Promise<void> {
  await db
    .update(accountDeletionRequests)
    .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(accountDeletionRequests.userId, userId),
        eq(accountDeletionRequests.status, "pending"),
      ),
    );
}

export async function countUsers(db: Db): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(isNull(users.deletedAt));
  return rows[0]?.count ?? 0;
}
