import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  accountDeletionRequests,
  emailDeliveryLogs,
  emailVerificationTokens,
  listings,
  payments,
  users,
} from "~/db/schema/index.ts";
import { LISTING_FEE_JPY } from "~/domain/pricing";
import { ulid } from "~/domain/ulid";
import { emailIndexHmac } from "~/server/crypto.server";
import type { Db } from "~/server/db.server";
import {
  requestAccountDeletion,
} from "~/server/repositories/user-repository.server";
import { purgeDueAccounts } from "~/server/services/erasure-service.server";
import { expireDueListings } from "~/server/services/listing-service.server";
import {
  closeTestDb,
  makeDraft,
  makeUser,
  resetDatabase,
  testEnv,
  testLogger,
} from "./helpers.ts";

/**
 * 退会と削除。
 *
 * ★この経路をテストで実際に動かす。★「対象なし」を返すスタブを通していると、
 * 本番で初めて実行される日まで一度も走らない。
 */
let db: Db;
const env = testEnv();

beforeEach(async () => {
  db = await resetDatabase();
});

afterAll(async () => {
  await closeTestDb();
});

describe("退会の申し込み", () => {
  it("30日後の予定として積まれる", async () => {
    const user = await makeUser(db, "leaving@example.test");
    const { scheduledPurgeAt } = await requestAccountDeletion(db, user.id);

    const days = Math.round(
      (scheduledPurgeAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
    );
    expect(days).toBe(30);
  });

  it("★連打しても依頼は1件だけ（部分一意索引）★", async () => {
    const user = await makeUser(db, "double@example.test");
    await requestAccountDeletion(db, user.id);
    await requestAccountDeletion(db, user.id);
    await requestAccountDeletion(db, user.id);

    const rows = await db
      .select({ id: accountDeletionRequests.id })
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.userId, user.id));
    expect(rows).toHaveLength(1);
  });
});

describe("★30日後の実削除★", () => {
  it("期限が来ていなければ消さない", async () => {
    const user = await makeUser(db, "notyet@example.test");
    await requestAccountDeletion(db, user.id);

    const result = await purgeDueAccounts({ db, env, logger: testLogger });
    expect(result.purged).toBe(0);

    const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
    expect(rows).toHaveLength(1);
  });

  it("期限を過ぎたら本人・投稿・写真が消える", async () => {
    const user = await makeUser(db, "purge-me@example.test");
    await makeDraft(db, user.id);
    await requestAccountDeletion(db, user.id);
    // 期限を過去にする
    await db
      .update(accountDeletionRequests)
      .set({ scheduledPurgeAt: new Date(Date.now() - 1000) })
      .where(eq(accountDeletionRequests.userId, user.id));

    const result = await purgeDueAccounts({ db, env, logger: testLogger });
    expect(result.purged).toBe(1);
    expect(result.failed).toBe(0);

    expect(
      await db.select({ id: users.id }).from(users).where(eq(users.id, user.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: listings.id })
        .from(listings)
        .where(eq(listings.ownerId, user.id)),
    ).toHaveLength(0);
  });

  it("★email_hmac で紐づく行も消える（user_id だけだと消し残る）★", async () => {
    const email = "hmac-linked@example.test";
    const user = await makeUser(db, email);
    const emailHmac = await emailIndexHmac(env.EMAIL_INDEX_KEY!, email);

    // user_id を持たない行（登録前に送った確認メールなど）を作る
    await db.insert(emailVerificationTokens).values({
      id: ulid(),
      userId: null,
      emailHmac,
      purpose: "login",
      tokenHash: "a".repeat(64),
      otpHash: "b".repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await db.insert(emailDeliveryLogs).values({
      id: ulid(),
      template: "login_code",
      recipientHmac: emailHmac,
      userId: null,
      idempotencyKey: `login_code:${ulid()}`,
      status: "sent",
    });

    await requestAccountDeletion(db, user.id);
    await db
      .update(accountDeletionRequests)
      .set({ scheduledPurgeAt: new Date(Date.now() - 1000) })
      .where(eq(accountDeletionRequests.userId, user.id));

    const result = await purgeDueAccounts({ db, env, logger: testLogger });
    expect(result.purged).toBe(1);

    expect(
      await db
        .select({ id: emailVerificationTokens.id })
        .from(emailVerificationTokens)
        .where(eq(emailVerificationTokens.emailHmac, emailHmac)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: emailDeliveryLogs.id })
        .from(emailDeliveryLogs)
        .where(eq(emailDeliveryLogs.recipientHmac, emailHmac)),
    ).toHaveLength(0);
  });

  it("★決済の記録は残るが、個人は特定できなくなる★", async () => {
    const user = await makeUser(db, "paid-then-left@example.test");
    const listingId = await makeDraft(db, user.id, { status: "published" });

    const paymentId = ulid();
    await db.insert(payments).values({
      id: paymentId,
      listingId,
      userId: user.id,
      checkoutSessionId: "cs_erasure_1",
      amountJpy: LISTING_FEE_JPY,
      currency: "jpy",
      status: "succeeded",
      paidAt: new Date(),
    });

    await requestAccountDeletion(db, user.id);
    await db
      .update(accountDeletionRequests)
      .set({ scheduledPurgeAt: new Date(Date.now() - 1000) })
      .where(eq(accountDeletionRequests.userId, user.id));

    const result = await purgeDueAccounts({ db, env, logger: testLogger });
    expect(result.failed).toBe(0);
    expect(result.purged).toBe(1);

    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountJpy).toBe(LISTING_FEE_JPY);
    // ★参照が外れている★
    expect(rows[0]!.userId).toBeNull();
    expect(rows[0]!.listingId).toBeNull();
  });

  it("★監査ログに個人情報を残さない★", async () => {
    const user = await makeUser(db, "audited@example.test");
    await requestAccountDeletion(db, user.id);
    await db
      .update(accountDeletionRequests)
      .set({ scheduledPurgeAt: new Date(Date.now() - 1000) })
      .where(eq(accountDeletionRequests.userId, user.id));

    await purgeDueAccounts({ db, env, logger: testLogger });

    const logs = await db.execute<{ payload: string }>(
      sql`select row_to_json(audit_logs)::text as payload from audit_logs`,
    );
    const combined = logs.rows.map((row) => row.payload).join("\n");
    expect(combined).not.toContain("audited@example.test");
    expect(combined).toContain("account.purged");
  });
});

describe("掲載期限の自動終了", () => {
  it("期限を過ぎた公開中の投稿が expired になる", async () => {
    const user = await makeUser(db, "expiring@example.test");
    const listingId = await makeDraft(db, user.id, {
      status: "published",
      publishedAt: new Date(Date.now() - 100_000),
      expiresAt: new Date(Date.now() - 1000),
    });

    const changed = await expireDueListings(db);
    expect(changed).toContain(listingId);

    const rows = await db
      .select({ status: listings.status })
      .from(listings)
      .where(eq(listings.id, listingId));
    expect(rows[0]!.status).toBe("expired");
  });

  it("期限内のものは触らない", async () => {
    const user = await makeUser(db, "still-open@example.test");
    const listingId = await makeDraft(db, user.id, {
      status: "published",
      publishedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const changed = await expireDueListings(db);
    expect(changed).not.toContain(listingId);
  });
});
