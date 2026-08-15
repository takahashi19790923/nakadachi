import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "~/db/schema/index.ts";
import { seedAll, truncateAll } from "~/db/seed/seed.ts";
import { ulid } from "~/domain/ulid";
import { asDb, type Db } from "~/server/db.server";
import type { AppEnv } from "~/server/env.server";
import { nullLogger } from "~/server/logger.server";
import { emailIndexHmac, encryptString, toBase64Url } from "~/server/crypto.server";
import { clearLocationCache } from "~/server/repositories/location-repository.server";
import { createUser } from "~/server/repositories/user-repository.server";

/**
 * 統合テストの共通処理。
 *
 * ★接続先が本番でないことをここで必ず確かめる。★ 統合テストは
 * 全テーブルを TRUNCATE する。テストを1回流しただけで本番データが消えた、
 * という事故は実際に起きている。
 */

let pool: pg.Pool | null = null;

export function testDb(): Db {
  const url: string | undefined = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL が未設定です（global-setup が動いていない）。");
  }
  // ★本番の接続文字列を弾く。★
  if (url.includes("neon.tech") && !url.includes("_test")) {
    throw new Error(
      "TEST_DATABASE_URL が本番らしき Neon を指しています。テスト用DBを別に作ってください。",
    );
  }

  pool ??= new pg.Pool({ connectionString: url, max: 5 });
  return asDb(drizzle(pool, { schema, casing: "snake_case" }));
}

export async function closeTestDb(): Promise<void> {
  await pool?.end();
  pool = null;
}

/** 各テストの前に呼ぶ。全テーブルを空にして seed を入れ直す */
export async function resetDatabase(): Promise<Db> {
  const db = testDb();
  await truncateAll(db);
  await seedAll(db);
  /*
   * ★地域データのキャッシュを捨てる。★ 参照データはアイソレート内に
   * 持ち回るので、消さないと前のテストで読んだ内容を見てしまう。
   * TRUNCATE した直後に「地域がある」ことになり、原因の分かりにくい
   * 通り方をする。
   */
  clearLocationCache();
  return db;
}

/** テスト用の env。実在の鍵ではない */
export function testEnv(): AppEnv {
  return {
    MEDIA: undefined as unknown as R2Bucket,
    ENVIRONMENT: "development",
    APP_ORIGIN: "http://localhost:5273",
    SESSION_COOKIE_NAME: "nakadachi_session",
    MAIL_FROM: "なかだち <notice@example.test>",
    EMAIL_REPLY_TO: "support@example.test",
    EXPECTED_CURRENCY: "jpy",
    TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    TURNSTILE_EXPECTED_HOSTS: "localhost",
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    SESSION_SECRET: "test-session-secret-not-a-real-value-0123456789",
    EMAIL_ENCRYPTION_KEY: toBase64Url(new Uint8Array(32).fill(7)),
    EMAIL_INDEX_KEY: toBase64Url(new Uint8Array(32).fill(9)),
    // 発信者情報の暗号化鍵。上の2つとは別の値にしてある（本番と同じ扱い）。
    ACCESS_LOG_KEY: toBase64Url(new Uint8Array(32).fill(11)),
    // ★実在の鍵ではない。★ 送信経路を通したいので値は入れる。
    // 送信先の fetch はテスト側で横取りするので、外へは出ない
    // （鍵が無いと email-service が送信自体を飛ばし、本文を検証できない）。
    //
    // ★本物と同じ形にしないこと。★ 以前 "re_" + 20文字以上にしていたら
    // pre-commit の秘密検査に引っかかった。偽物が本物の形をしていると、
    // 検査が鳴るたびに「どうせテスト値」と流す癖がつく。
    RESEND_API_KEY: "dummy-not-a-key",
    STRIPE_SECRET_KEY: "sk_test_not_a_real_key",
    STRIPE_WEBHOOK_SECRET: "whsec_test_not_a_real_secret",
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    ADMIN_BASIC_AUTH_USER: "test-admin",
    ADMIN_BASIC_AUTH_PASS: "test-admin-password",
  };
}

export const testLogger = nullLogger;

/** テスト用の利用者を作る */
export async function makeUser(
  db: Db,
  email: string,
  role: "user" | "admin" = "user",
): Promise<{ id: string; email: string }> {
  const env = testEnv();
  const emailHmac = await emailIndexHmac(env.EMAIL_INDEX_KEY!, email);
  const user = await createUser(db, env, { email, emailHmac, role });
  return { id: user.id, email };
}

/** カテゴリ ID を slug から引く */
export async function categoryId(db: Db, slug: string): Promise<string> {
  const rows = await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(eq(schema.categories.slug, slug))
    .limit(1);
  const id = rows[0]?.id;
  if (!id) throw new Error(`カテゴリが見つかりません: ${slug}`);
  return id;
}

/** テスト用の投稿を1件作る（下書き） */
export async function makeDraft(
  db: Db,
  ownerId: string,
  overrides: Partial<typeof schema.listings.$inferInsert> = {},
): Promise<string> {
  const id = ulid();
  await db.insert(schema.listings).values({
    id,
    ownerId,
    categoryId: await categoryId(db, "sell-buy"),
    kind: "sell",
    title: "テスト用の投稿",
    body: "テスト用の説明文です。十分な長さがあります。",
    status: "draft",
    priceJpy: 1000,
    priceType: "fixed",
    priceUnit: "once",
    prefectureCode: "13",
    cityCode: "13107",
    ...overrides,
  });
  await db
    .insert(schema.listingCategoryDetails)
    .values({ listingId: id, itemCondition: "good", handoverMethod: "pickup" });
  return id;
}

/** 暗号化済みのメールアドレス（テストの前提を作るのに使う） */
export async function encryptTestEmail(email: string): Promise<string> {
  return encryptString(testEnv().EMAIL_ENCRYPTION_KEY!, email);
}
