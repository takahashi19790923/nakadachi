import { and, eq, isNull, sql } from "drizzle-orm";

import { sessions, users } from "~/db/schema/index.ts";
import { ulid } from "~/domain/ulid.ts";
import { expireCookie, readCookie, serializeCookie } from "./cookies.server.ts";
import { hashIp, randomToken, sha256Hex } from "./crypto.server.ts";
import type { Db } from "./db.server.ts";
import { isSecureOrigin, requireSecret, type AppEnv } from "./env.server.ts";

/**
 * セッションの寿命。
 *
 * ★「使っているあいだは切れない、放置は早く切れる」を両立させる。★
 * （2026-08-28。30日固定 → 90日固定 → この形へ）
 *
 * このサイトは合言葉を持たない。メールでしか入れないので、
 * ★セッションが切れる ＝ ログインコードのメールが1通増える★。
 * 一方で、期間を延ばすほど「端末を離れた隙に使える時間」も延びる。
 * 固定の期間ではこの2つが正面からぶつかる。
 *
 *   30日固定 … 毎日使う人でも年12回ログインし直す（メールが多い）
 *   90日固定 … 年4回。ただし1回使ったきり放置された端末も90日入れる
 *
 * 使うたびに期限を延ばすと、両方よくなる。
 *
 *   毎日使う人   … 実質ログインし直さない（メールは年1回＝下の上限のぶん）
 *   放置された端末 … 最後に使ってから30日で切れる
 *
 * ★上限が要る理由。★ 延ばし続けるだけだと、盗まれた Cookie も
 * 使われているかぎり永久に有効になる。作られてからの上限を別に置いて、
 * どれだけ使われていても必ずいつかは切れるようにする。
 */

/** 最後に使ってからこの期間で切れる（使うたびに延びる） */
export const SESSION_IDLE_SECONDS = 30 * 24 * 60 * 60;

/**
 * 作られてからの上限。延長し続けても、ここで必ず切れる。
 * 1年に1回ログインし直す＝メールは利用者1人あたり年1通。
 */
export const SESSION_ABSOLUTE_MAX_SECONDS = 365 * 24 * 60 * 60;

/**
 * 延長する条件：残りが窓の半分を切ったとき。
 *
 * ★毎回 UPDATE しない。★ 読むだけの画面にも書き込みが乗ると、
 * 閲覧のたびに DB へ書くことになる（一覧を見ているだけの人が大半なので、
 * そこが一番効く）。半分で延ばせば、更新は15日に1回で足りる。
 */
const REFRESH_WHEN_REMAINING_BELOW = (SESSION_IDLE_SECONDS * 1000) / 2;

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
  const expiresAt = new Date(Date.now() + SESSION_IDLE_SECONDS * 1000);

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
      maxAgeSeconds: SESSION_IDLE_SECONDS,
    }),
  };
}

/**
 * セッションを延ばすための配線。
 *
 * ★どちらも必須にしてある。★ 省略可能にすると、新しい呼び出し元が
 * 渡し忘れても型もテストも通り、★延長だけが静かに効かなくなる★
 * （画面は正常に動くので、利用者が「また入り直しになった」と
 * 気づくまで誰にも分からない）。渡すものが無い場面では、
 * 「延ばさない」と明示して no-op を渡すこと。
 */
export interface SessionRenewal {
  /** 延ばしたときの Set-Cookie。応答へ必ず足すこと */
  setCookie: (value: string) => void;
  /** 応答を返したあとに走らせる DB 更新を預ける（AppContext.defer） */
  defer: (promise: Promise<unknown>) => void;
}

/** 延ばさない場合に渡すもの。テストや、延長が要らない経路で使う */
export const NO_SESSION_RENEWAL: SessionRenewal = {
  setCookie: () => undefined,
  defer: () => undefined,
};

/**
 * Cookie からログイン中の利用者を引く。
 *
 * 停止・削除済みの利用者は「ログインしていない」として扱う。
 * 画面側で弾くだけにすると、API を直接叩かれたときに素通りする。
 *
 * ★ついでに期限を延ばす（sliding expiration）。★ 詳しくは
 * ファイル冒頭の SESSION_IDLE_SECONDS のコメント。
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
  renew: SessionRenewal;
  /** テストから時刻を固定するため。既定は現在時刻 */
  now?: Date;
}): Promise<SessionUser | null> {
  const { getDb, env, request, renew } = options;
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
      createdAt: sessions.createdAt,
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

  renewSession({
    db,
    env,
    token,
    row,
    renew,
    now: options.now ?? new Date(),
  });

  return {
    id: row.userId,
    role: row.role,
    status: row.status,
    sessionId: row.sessionId,
  };
}

/**
 * 使われたので期限を延ばす。
 *
 * ★DB と Cookie の両方を延ばす。★ 片方だけだと、
 *   - DB だけ … ブラウザが先に Cookie を捨てるので、結局ログアウトする
 *   - Cookie だけ … Cookie は送られてくるが DB 側で切れていて弾かれる
 * どちらも「延ばしたつもりで延びていない」状態になる。
 *
 * 延ばすのは残りが半分を切ったときだけ。毎回 UPDATE すると、
 * 読むだけの画面にも書き込みが乗る。
 */
function renewSession(options: {
  db: Db;
  env: AppEnv;
  token: string;
  row: { sessionId: string; expiresAt: Date; createdAt: Date };
  renew: SessionRenewal;
  now: Date;
}): void {
  const { db, env, token, row, renew, now } = options;

  const nowMs = now.getTime();
  const remaining = row.expiresAt.getTime() - nowMs;
  if (remaining >= REFRESH_WHEN_REMAINING_BELOW) return;

  /*
   * ★作られてからの上限で頭を押さえる。★ ここが無いと、使われ続ける
   * かぎり永久に有効なセッションができる（盗まれた Cookie も含めて）。
   */
  const hardLimit =
    row.createdAt.getTime() + SESSION_ABSOLUTE_MAX_SECONDS * 1000;
  const next = Math.min(nowMs + SESSION_IDLE_SECONDS * 1000, hardLimit);

  // 上限に達していれば、もう延ばせない。書き込みもしない。
  if (next <= row.expiresAt.getTime()) return;

  const nextDate = new Date(next);
  renew.defer(
    db
      .update(sessions)
      .set({ expiresAt: nextDate, lastUsedAt: now, updatedAt: now })
      .where(eq(sessions.id, row.sessionId)),
  );

  renew.setCookie(
    serializeCookie(env.SESSION_COOKIE_NAME, token, {
      ...cookieOptions(env),
      maxAgeSeconds: Math.floor((next - nowMs) / 1000),
    }),
  );
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
