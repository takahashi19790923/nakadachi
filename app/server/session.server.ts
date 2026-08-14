import { and, eq, isNull, sql } from "drizzle-orm";

import { sessions, users } from "~/db/schema/index.ts";
import { ulid } from "~/domain/ulid.ts";
import { expireCookie, readCookie, serializeCookie } from "./cookies.server.ts";
import { hashIp, randomToken, sha256Hex } from "./crypto.server.ts";
import type { Db } from "./db.server.ts";
import { isSecureOrigin, requireSecret, type AppEnv } from "./env.server.ts";

/** 30日。長くすると、端末を離れた隙に使える時間が延びる */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface SessionUser {
  readonly id: string;
  readonly role: "user" | "admin";
  readonly status: "active" | "suspended" | "deleted";
  readonly sessionId: string;
}

function cookieOptions(env: AppEnv) {
  return {
    secure: isSecureOrigin(env),
    httpOnly: true,
    // Lax にしている理由は cookies.server.ts のコメントを参照。
    sameSite: "Lax" as const,
    path: "/",
  };
}

/**
 * セッションを新しく作る。
 *
 * ★ログインのたびに必ず新しい行とトークンを作る（使い回さない）。★
 * 既存のセッション ID を認証後もそのまま使うと、攻撃者が事前に配った
 * セッション ID で被害者のログイン状態に相乗りできる（セッション固定攻撃）。
 */
export async function createSession(options: {
  db: Db;
  env: AppEnv;
  userId: string;
  request: Request;
}): Promise<{ setCookie: string }> {
  const { db, env, userId, request } = options;

  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const sessionSecret = requireSecret(env, "SESSION_SECRET");

  const ip = clientIp(request);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  await db.insert(sessions).values({
    id: ulid(),
    userId,
    tokenHash,
    ipHash: ip ? await hashIp(sessionSecret, ip) : null,
    userAgent: (request.headers.get("user-agent") ?? "").slice(0, 200) || null,
    expiresAt,
  });

  await db
    .update(users)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));

  return {
    setCookie: serializeCookie(env.SESSION_COOKIE_NAME, token, {
      ...cookieOptions(env),
      maxAgeSeconds: SESSION_TTL_SECONDS,
    }),
  };
}

/**
 * Cookie からログイン中の利用者を引く。
 *
 * 停止・削除済みの利用者は「ログインしていない」として扱う。
 * 画面側で弾くだけにすると、API を直接叩かれたときに素通りする。
 */
export async function getSessionUser(options: {
  /**
   * ★DB クライアントは遅延生成のまま受け取る。★
   * ここで先に db を作ってしまうと、Cookie を持たない訪問者
   * （公開ページを見ているだけの人）にも毎回 DB 接続が作られる。
   * 無駄なだけでなく、DATABASE_URL が無い環境では規約ページすら
   * 500 になる（ローカルの初回起動と E2E で実際に踏んだ）。
   */
  getDb: () => Db;
  env: AppEnv;
  request: Request;
}): Promise<SessionUser | null> {
  const { getDb, env, request } = options;
  const token = readCookie(request, env.SESSION_COOKIE_NAME);
  if (!token) return null;

  const db = getDb();
  const tokenHash = await sha256Hex(token);
  const rows = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      role: users.role,
      status: users.status,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > now()`,
        isNull(users.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.status !== "active") return null;

  return {
    id: row.userId,
    role: row.role,
    status: row.status,
    sessionId: row.sessionId,
  };
}

/** 最終利用時刻の更新。応答をブロックしないよう waitUntil から呼ぶ */
export async function touchSession(db: Db, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(sessions.id, sessionId));
}

/** ログアウト。DB 側でも無効にする（Cookie を消すだけでは足りない） */
export async function destroySession(options: {
  db: Db;
  env: AppEnv;
  request: Request;
}): Promise<{ setCookie: string }> {
  const { db, env, request } = options;
  const token = readCookie(request, env.SESSION_COOKIE_NAME);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.tokenHash, tokenHash));
  }
  return { setCookie: expireCookie(env.SESSION_COOKIE_NAME, cookieOptions(env)) };
}

/**
 * その利用者の全セッションを失効させる。
 * 停止・退会・メールアドレス変更・返金による無効化で必ず呼ぶ。
 * 「止めたのに入ったまま」では意味がない。
 */
export async function revokeAllSessions(
  db: Db,
  userId: string,
): Promise<number> {
  const result = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  return result.rowCount ?? 0;
}

/** 期限切れセッションの掃除。定期処理から呼ぶ */
export async function purgeExpiredSessions(db: Db): Promise<number> {
  const result = await db.execute(
    sql`delete from sessions where expires_at <= now() - interval '7 days'`,
  );
  return result.rowCount ?? 0;
}

/** Cloudflare が付ける接続元 IP。信用してよいのは CF-Connecting-IP だけ */
export function clientIp(request: Request): string | null {
  return request.headers.get("cf-connecting-ip");
}
