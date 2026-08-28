import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { emailVerificationTokens } from "~/db/schema/index.ts";
import { ulid } from "~/domain/ulid.ts";
import { writeAuditLog } from "../audit.server.ts";
import {
  emailIndexHmac,
  encryptString,
  generateOtp,
  hashIp,
  otpHash as otpHashOf,
  randomToken,
  sha256Hex,
  timingSafeEqual,
} from "../crypto.server.ts";
import type { Db } from "../db.server.ts";
import { requireSecret, type AppEnv } from "../env.server.ts";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.server.ts";
import { enforceRateLimit } from "../rate-limit.server.ts";
import {
  createUser,
  decryptUserEmail,
  findUserByEmailHmac,
  type UserRecord,
} from "../repositories/user-repository.server.ts";
import { clientIp } from "../session.server.ts";
import { sendEmail } from "./email/email-service.server.ts";
import { loginCodeEmail } from "./email/templates.server.ts";

/**
 * パスワードレス認証。
 *
 * 守っていること
 *  - トークンと OTP を平文で保存しない（SHA-256 だけを持つ）
 *  - 有効期限がある。一度使えば再利用できない
 *  - ★応答からアドレスの登録有無を推測させない★
 *  - 試行回数の上限とレート制限で 6桁 OTP の総当たりを止める
 */

/** 15分。長くすると、メールを覗かれたときに使える時間が延びる */
const TOKEN_TTL_MINUTES = 15;
/** OTP の入力を何回まで許すか。6桁は100万通りしかない */
const MAX_OTP_ATTEMPTS = 5;

export interface LoginRequestResult {
  /** 画面に出す文言は成功・失敗で変えない。ここは常に true */
  readonly accepted: true;
}

/**
 * ログイン用のコードとリンクを送る。
 *
 * ★アドレスが登録済みかどうかで挙動を変えないこと。★
 * 未登録でもトークンを作ってメールを送る（初回ログイン＝登録）。
 * 「そのアドレスは登録されていません」を返すと、総当たりで会員名簿が作れる。
 */
export async function requestLoginCode(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  request: Request;
  email: string;
  purpose?: "login";
}): Promise<LoginRequestResult> {
  const { db, env, logger, request, email } = options;

  const indexKey = requireSecret(env, "EMAIL_INDEX_KEY");
  const sessionSecret = requireSecret(env, "SESSION_SECRET");
  const emailHmac = await emailIndexHmac(indexKey, email);

  /*
   * ★短い窓と1日の総量を両方見る。★ 10分10回だけだと、待てば1日1,440通に
   * なる。送信事業者の枠が尽きた時点で、このサイトは合言葉を持たない
   * （メールでしか入れない）ので全員が締め出される。窓を短くすると
   * 正規の利用者が困るので、上限を2段にして1日側で頭を押さえる。
   */
  const ip = clientIp(request);
  if (ip) {
    const ipHash = await hashIp(sessionSecret, ip);
    await enforceRateLimit(db, "authRequestByIp", ipHash);
    await enforceRateLimit(db, "authRequestByIpDaily", ipHash);
  }
  // アドレス単位でも絞る。他人のアドレスへ大量に送りつける嫌がらせを防ぐ。
  await enforceRateLimit(db, "authRequestByEmail", emailHmac);
  await enforceRateLimit(db, "authRequestByEmailDaily", emailHmac);

  const existing = await findUserByEmailHmac(db, emailHmac);
  if (existing && existing.status === "suspended") {
    // 停止中でも同じ応答を返す。ここで差を出すと停止の有無が漏れる。
    logger.warn("login requested for suspended account");
    return { accepted: true };
  }

  const token = randomToken(32);
  const otp = generateOtp(6);
  const tokenId = ulid();

  // 同じアドレスの未使用トークンは無効にする。古いコードが生き続けると、
  // 攻撃者が観測した1つを使い回せる時間が延びる。
  await db
    .update(emailVerificationTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(emailVerificationTokens.emailHmac, emailHmac),
        eq(emailVerificationTokens.purpose, "login"),
        isNull(emailVerificationTokens.consumedAt),
      ),
    );

  await db.insert(emailVerificationTokens).values({
    id: tokenId,
    userId: existing?.id ?? null,
    emailHmac,
    purpose: "login",
    tokenHash: await sha256Hex(token),
    otpHash: await otpHashOf(sessionSecret, tokenId, otp),
    // 未登録のアドレスなら、確認できた時点で利用者を作れるよう暗号文を預けておく。
    // ★平文では持たない。★ 検証が済むか期限が切れるまでの一時的な保管で、
    // 利用者を作った時点で null に戻す。
    newEmailEncrypted: existing
      ? null
      : await encryptString(requireSecret(env, "EMAIL_ENCRYPTION_KEY"), email),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000),
    requestedIpHash: ip ? await hashIp(sessionSecret, ip) : null,
  });

  const linkUrl = new URL(`/login/link?token=${token}`, env.APP_ORIGIN).toString();

  await sendEmail(
    {
      template: "login_code",
      to: email,
      content: loginCodeEmail({
        otp,
        linkUrl,
        expiresInMinutes: TOKEN_TTL_MINUTES,
      }),
      // トークン ID を鍵にする。同じ要求で二重に送らない。
      idempotencyKey: `login_code:${tokenId}`,
      userId: existing?.id,
    },
    { db, env, logger },
  );

  await writeAuditLog(db, env, {
    action: "auth.login_code_requested",
    actorId: existing?.id ?? null,
    targetType: "email",
    // ★アドレスそのものを入れない。★ HMAC の先頭だけを残す。
    targetId: emailHmac.slice(0, 16),
    request,
  });

  return { accepted: true };
}

/** 検証に失敗したときの共通の例外。理由の差を利用者に見せない */
function verificationFailed(detail: string): AppError {
  return new AppError(
    "validation_failed",
    "確認コードが正しくないか、有効期限が切れています。もう一度お試しください。",
    { detail, fields: { otp: "確認コードをご確認ください" } },
  );
}

/**
 * ログインの失敗を記録して、例外を返す。
 *
 * ★2026-08-28 まで、ログインの成功も失敗も一切残っていなかった。★
 * `auth.login_code_requested`（コードを送った）だけがあり、その先で
 * 通ったのか弾かれたのかは分からない。総当たりを受けても、
 * 「どのアドレスが・どこから・何回」を後から一切たどれなかった
 * （ASVS 5.0 L2 の要求項目でもある）。
 *
 * ★アドレスそのものは残さない。★ 監査ログは個人情報を含まない形で
 * 保つと公表しているので、HMAC 済みの索引値だけを入れる。
 * IP も writeAuditLog がハッシュ化して入れる。
 *
 * ★記録できなくてもログインの判定は変えない。★ 監査の失敗で
 * 利用者を締め出さない（writeAuditLog 自体も投げない作りになっている）。
 */
async function failLogin(options: {
  db: Db;
  env: AppEnv;
  request: Request;
  emailHmac: string | null;
  /** 粗い理由。総当たりの相手に手がかりを与えない粒度にする */
  reason: "no_token" | "attempt_limit" | "otp_mismatch" | "bad_link";
  detail: string;
}): Promise<AppError> {
  await writeAuditLog(options.db, options.env, {
    action: "auth.login_failed",
    actorRole: "anonymous",
    targetType: "email_hmac",
    // ★先頭だけ。★ 列は varchar(40)（writeAuditLog 側でも切っているが、
    // 呼ぶ側でも «何を入れているか» が読めるようにしておく）。
    targetId: options.emailHmac?.slice(0, 16),
    request: options.request,
    metadata: { reason: options.reason },
  });
  return verificationFailed(options.detail);
}

interface VerifiedIdentity {
  readonly user: UserRecord;
  readonly isNewUser: boolean;
}

async function finalize(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  request: Request;
  tokenId: string;
  emailHmac: string;
  existingUserId: string | null;
}): Promise<VerifiedIdentity> {
  const { db, env, tokenId, emailHmac, existingUserId } = options;

  // ★使用済みにするのは1回だけ成立させる。★ status を WHERE に入れて、
  // 同時に2回来ても片方しか通らないようにする。
  const consumed = await db
    .update(emailVerificationTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(emailVerificationTokens.id, tokenId),
        isNull(emailVerificationTokens.consumedAt),
      ),
    );

  if ((consumed.rowCount ?? 0) === 0) {
    throw verificationFailed("token already consumed");
  }

  let user = existingUserId ? await findUserByEmailHmac(db, emailHmac) : null;
  let isNewUser = false;

  if (!user) {
    // 初回ログイン＝登録。平文のアドレスはこの時点でしか手元に無いので、
    // トークン行から復元できるよう userId を紐づけておく。
    const emailRow = await db
      .select({ newEmailEncrypted: emailVerificationTokens.newEmailEncrypted })
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.id, tokenId))
      .limit(1);
    const pendingEmail = emailRow[0]?.newEmailEncrypted;
    if (!pendingEmail) {
      throw verificationFailed("no email material to create user");
    }
    const plain = await decryptUserEmail(env, pendingEmail);
    user = await createUser(db, env, { email: plain, emailHmac });
    isNewUser = true;
    await db
      .update(emailVerificationTokens)
      .set({ userId: user.id, newEmailEncrypted: null })
      .where(eq(emailVerificationTokens.id, tokenId));
  }

  if (user.status !== "active") {
    await writeAuditLog(db, env, {
      action: "auth.login_failed",
      actorId: user.id,
      actorRole: "anonymous",
      request: options.request,
      metadata: { reason: `status_${user.status}` },
    });
    throw new AppError(
      "forbidden",
      "このアカウントはご利用いただけません。お問い合わせください。",
      { detail: `login attempted on status=${user.status}` },
    );
  }

  /*
   * ★ここが「入れた」の唯一の合流点。★ OTP でもマジックリンクでも
   * 必ずここを通る。成功だけを残しても意味は薄く、失敗だけでも意味は薄い。
   * 両方あって初めて「10回失敗したあと1回成功した」が読める。
   */
  await writeAuditLog(db, env, {
    action: "auth.login_succeeded",
    actorId: user.id,
    request: options.request,
    metadata: { newUser: isNewUser ? 1 : 0 },
  });

  return { user, isNewUser };
}

/** OTP による確認 */
export async function verifyLoginOtp(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  request: Request;
  email: string;
  otp: string;
}): Promise<VerifiedIdentity> {
  const { db, env, request, email, otp } = options;

  const sessionSecret = requireSecret(env, "SESSION_SECRET");
  const emailHmac = await emailIndexHmac(
    requireSecret(env, "EMAIL_INDEX_KEY"),
    email,
  );

  const ip = clientIp(request);
  if (ip) {
    await enforceRateLimit(db, "authVerifyByIp", await hashIp(sessionSecret, ip));
  }

  const rows = await db
    .select({
      id: emailVerificationTokens.id,
      userId: emailVerificationTokens.userId,
      otpHash: emailVerificationTokens.otpHash,
      attemptCount: emailVerificationTokens.attemptCount,
      expiresAt: emailVerificationTokens.expiresAt,
    })
    .from(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.emailHmac, emailHmac),
        eq(emailVerificationTokens.purpose, "login"),
        isNull(emailVerificationTokens.consumedAt),
        sql`${emailVerificationTokens.expiresAt} > now()`,
      ),
    )
    .orderBy(desc(emailVerificationTokens.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw await failLogin({
      db, env, request, emailHmac,
      reason: "no_token",
      detail: "no active token",
    });
  }

  await enforceRateLimit(db, "authVerifyByToken", row.id);

  if (row.attemptCount >= MAX_OTP_ATTEMPTS) {
    // 上限に達したら、そのトークン自体を捨てる。
    await db
      .update(emailVerificationTokens)
      .set({ consumedAt: new Date() })
      .where(eq(emailVerificationTokens.id, row.id));
    throw await failLogin({
      db, env, request, emailHmac,
      reason: "attempt_limit",
      detail: "attempt limit reached",
    });
  }

  await db
    .update(emailVerificationTokens)
    .set({ attemptCount: sql`${emailVerificationTokens.attemptCount} + 1` })
    .where(eq(emailVerificationTokens.id, row.id));

  const matches = await timingSafeEqual(
    await otpHashOf(sessionSecret, row.id, otp),
    row.otpHash,
  );
  if (!matches) {
    throw await failLogin({
      db, env, request, emailHmac,
      reason: "otp_mismatch",
      detail: "otp mismatch",
    });
  }

  return finalize({
    ...options,
    tokenId: row.id,
    emailHmac,
    existingUserId: row.userId,
  });
}

/** マジックリンクによる確認 */
export async function verifyLoginLink(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  request: Request;
  token: string;
}): Promise<VerifiedIdentity> {
  const { db, env, request, token } = options;

  const ip = clientIp(request);
  if (ip) {
    await enforceRateLimit(
      db,
      "authVerifyByIp",
      await hashIp(requireSecret(env, "SESSION_SECRET"), ip),
    );
  }

  const tokenHash = await sha256Hex(token);
  const rows = await db
    .select({
      id: emailVerificationTokens.id,
      userId: emailVerificationTokens.userId,
      emailHmac: emailVerificationTokens.emailHmac,
    })
    .from(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.tokenHash, tokenHash),
        eq(emailVerificationTokens.purpose, "login"),
        isNull(emailVerificationTokens.consumedAt),
        sql`${emailVerificationTokens.expiresAt} > now()`,
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw await failLogin({
      db, env, request,
      emailHmac: null,
      reason: "bad_link",
      detail: "link token not found or expired",
    });
  }

  return finalize({
    ...options,
    tokenId: row.id,
    emailHmac: row.emailHmac,
    existingUserId: row.userId,
  });
}

/**
 * 期限切れトークンの掃除。定期処理から呼ぶ。
 * 残しておくと、退会したはずの人の HMAC が延々と残る。
 */
export async function purgeExpiredTokens(db: Db): Promise<number> {
  const result = await db.execute(
    sql`delete from email_verification_tokens where expires_at <= now() - interval '1 day'`,
  );
  return result.rowCount ?? 0;
}
