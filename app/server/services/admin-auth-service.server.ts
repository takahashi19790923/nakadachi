import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { emailVerificationTokens, users } from "~/db/schema/index.ts";
import { ulid } from "~/domain/ulid.ts";
import {
  emailIndexHmac,
  generateOtp,
  otpHash as otpHashOf,
  sha256Hex,
  timingSafeEqual,
} from "../crypto.server.ts";
import type { Db } from "../db.server.ts";
import { requireSecret, type AppEnv } from "../env.server.ts";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.server.ts";
import { enforceRateLimit } from "../rate-limit.server.ts";
import { decryptUserEmail } from "../repositories/user-repository.server.ts";
import { sendEmail } from "./email/email-service.server.ts";
import { loginCodeEmail } from "./email/templates.server.ts";

/**
 * 管理画面の第2層（管理者だけの再認証）。
 *
 * 第1層（通常のメールログイン）を通っていても、管理データに触る前に
 * もう一度メールで確認する。端末を離れた隙に管理画面へ入られることを防ぐ。
 *
 * 第3層（共通の資格情報）とは独立。両方を満たさないと通過証は出ない。
 */

const REAUTH_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

export async function sendAdminReauthCode(options: {
  db: Db;
  env: AppEnv;
  logger: Logger;
  adminId: string;
}): Promise<void> {
  const { db, env, logger, adminId } = options;

  await enforceRateLimit(db, "authRequestByEmail", `admin_reauth:${adminId}`);

  const rows = await db
    .select({ emailEncrypted: users.emailEncrypted, role: users.role })
    .from(users)
    .where(and(eq(users.id, adminId), isNull(users.deletedAt)))
    .limit(1);

  const row = rows[0];
  if (!row || row.role !== "admin") {
    throw new AppError("forbidden", "この操作は行えません。", {
      detail: "admin reauth requested by non-admin",
    });
  }

  const email = await decryptUserEmail(env, row.emailEncrypted);
  const emailHmac = await emailIndexHmac(
    requireSecret(env, "EMAIL_INDEX_KEY"),
    email,
  );

  // 未使用の再認証コードは無効にする。
  await db
    .update(emailVerificationTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(emailVerificationTokens.userId, adminId),
        eq(emailVerificationTokens.purpose, "admin_reauth"),
        isNull(emailVerificationTokens.consumedAt),
      ),
    );

  const otp = generateOtp(6);
  const tokenId = ulid();

  await db.insert(emailVerificationTokens).values({
    id: tokenId,
    userId: adminId,
    emailHmac,
    purpose: "admin_reauth",
    // 管理者の再認証はリンクを使わない（メールを覗かれただけで通らないように）。
    tokenHash: await sha256Hex(`unused:${tokenId}`),
    otpHash: await otpHashOf(requireSecret(env, "SESSION_SECRET"), tokenId, otp),
    expiresAt: new Date(Date.now() + REAUTH_TTL_MINUTES * 60 * 1000),
  });

  await sendEmail(
    {
      template: "login_code",
      to: email,
      content: loginCodeEmail({
        otp,
        // リンクは使わないので、案内先は管理ゲートにする。
        linkUrl: new URL("/admin/gate", env.APP_ORIGIN).toString(),
        expiresInMinutes: REAUTH_TTL_MINUTES,
      }),
      idempotencyKey: `admin_reauth:${tokenId}`,
      userId: adminId,
    },
    { db, env, logger },
  );
}

export async function verifyAdminReauthCode(options: {
  db: Db;
  // 保存時と同じ鍵でハッシュを作り直すために要る（鍵無しでは照合できない）。
  env: AppEnv;
  adminId: string;
  otp: string;
}): Promise<void> {
  const { db, env, adminId, otp } = options;

  const rows = await db
    .select({
      id: emailVerificationTokens.id,
      otpHash: emailVerificationTokens.otpHash,
      attemptCount: emailVerificationTokens.attemptCount,
    })
    .from(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.userId, adminId),
        eq(emailVerificationTokens.purpose, "admin_reauth"),
        isNull(emailVerificationTokens.consumedAt),
        sql`${emailVerificationTokens.expiresAt} > now()`,
      ),
    )
    .orderBy(desc(emailVerificationTokens.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new AppError("validation_failed", "確認コードを送信してください。", {
      detail: "no active admin reauth token",
      fields: { otp: "確認コードが無効です" },
    });
  }

  if (row.attemptCount >= MAX_ATTEMPTS) {
    await db
      .update(emailVerificationTokens)
      .set({ consumedAt: new Date() })
      .where(eq(emailVerificationTokens.id, row.id));
    throw new AppError("validation_failed", "確認コードが無効になりました。", {
      detail: "admin reauth attempt limit",
      fields: { otp: "もう一度コードを送信してください" },
    });
  }

  await db
    .update(emailVerificationTokens)
    .set({ attemptCount: sql`${emailVerificationTokens.attemptCount} + 1` })
    .where(eq(emailVerificationTokens.id, row.id));

  const matches = await timingSafeEqual(
    await otpHashOf(requireSecret(env, "SESSION_SECRET"), row.id, otp),
    row.otpHash,
  );
  if (!matches) {
    throw new AppError("validation_failed", "確認コードが正しくありません。", {
      detail: "admin reauth otp mismatch",
      fields: { otp: "確認コードをご確認ください" },
    });
  }

  const consumed = await db
    .update(emailVerificationTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(emailVerificationTokens.id, row.id),
        isNull(emailVerificationTokens.consumedAt),
      ),
    );

  if ((consumed.rowCount ?? 0) === 0) {
    throw new AppError("validation_failed", "確認コードが無効になりました。", {
      detail: "admin reauth token already consumed",
    });
  }
}
