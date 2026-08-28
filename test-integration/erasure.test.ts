import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  accountDeletionRequests,
  emailDeliveryLogs,
  emailVerificationTokens,
  listingImages,
  listings,
  payments,
  users,
} from "~/db/schema/index.ts";
import { LISTING_FEE_JPY } from "~/domain/pricing";
import { ulid } from "~/domain/ulid";
import {
  CRON_DAILY,
  CRON_HOURLY,
  runScheduledTasks,
} from "~/server/cron.server";
import { emailIndexHmac } from "~/server/crypto.server";
import type { Db } from "~/server/db.server";
import {
  requestAccountDeletion,
} from "~/server/repositories/user-repository.server";
import {
  closeListingsOnDeletionRequest,
  purgeDueAccounts,
} from "~/server/services/erasure-service.server";
import { expireDueListings } from "~/server/services/listing-service.server";
import { notifyAccountDeletionRequested } from "~/server/services/notification-service.server";
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

  it("連打の2回目以降は最初の依頼を返す（予定日がずれない）", async () => {
    const user = await makeUser(db, "same-date@example.test");
    const first = await requestAccountDeletion(db, user.id);
    const second = await requestAccountDeletion(db, user.id);
    expect(second.id).toBe(first.id);
    expect(second.scheduledPurgeAt.getTime()).toBe(first.scheduledPurgeAt.getTime());
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  it("★申し込んだ時点で公開中の投稿が終了する（30日間出続けない）★", async () => {
    /*
     * 画面で「お申し込みの時点で掲載を終了します」と約束している。
     * 関数はあったのに呼んでおらず、嫌がらせが理由で退会する人の掲載に
     * 30日間問い合わせが届き続けた。
     */
    const user = await makeUser(db, "close-on-request@example.test");
    const live = await makeDraft(db, user.id, {
      status: "published",
      publishedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    const draft = await makeDraft(db, user.id, { status: "draft" });

    const closed = await closeListingsOnDeletionRequest(db, user.id);
    expect(closed).toBe(1);

    const [liveRow] = await db
      .select({ status: listings.status, closedAt: listings.closedAt })
      .from(listings)
      .where(eq(listings.id, live));
    expect(liveRow!.status).toBe("closed");
    expect(liveRow!.closedAt).not.toBeNull();
    // 下書きは触らない（消すのは30日後）。
    const [draftRow] = await db
      .select({ status: listings.status })
      .from(listings)
      .where(eq(listings.id, draft));
    expect(draftRow!.status).toBe("draft");
  });

  it("★取り消しの案内が本人へ届く★（テンプレートだけあって送っていなかった）", async () => {
    const user = await makeUser(db, "notify-deletion@example.test");
    const deletion = await requestAccountDeletion(db, user.id);

    await notifyAccountDeletionRequested({
      db,
      env,
      logger: testLogger,
      userId: user.id,
      requestId: deletion.id,
      scheduledPurgeAt: deletion.scheduledPurgeAt,
    });
    // 同じ依頼でもう一度呼んでも二重には送らない。
    await notifyAccountDeletionRequested({
      db,
      env,
      logger: testLogger,
      userId: user.id,
      requestId: deletion.id,
      scheduledPurgeAt: deletion.scheduledPurgeAt,
    });

    const sent = await db
      .select({ id: emailDeliveryLogs.id })
      .from(emailDeliveryLogs)
      .where(eq(emailDeliveryLogs.template, "account_deletion"));
    expect(sent).toHaveLength(1);
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

  it("★写真の実体（R2）も消える。行だけ消えて実体が残らない★", async () => {
    /*
     * 以前は行に「削除待ち」の印をつけて別の定期処理に任せていたが、
     * 直後の投稿の物理削除で listing_images が連鎖削除され、印ごと消えていた。
     * R2 のオブジェクトだけが永久に取り残され、DB から辿る手段も無い。
     */
    const user = await makeUser(db, "purge-images@example.test");
    const listingId = await makeDraft(db, user.id);
    const keys = [`listings/${listingId}/a`, `listings/${listingId}/b`];
    for (const [i, objectKey] of keys.entries()) {
      await db.insert(listingImages).values({
        id: ulid(),
        listingId,
        objectKey,
        contentType: "image/jpeg",
        byteSize: 1000,
        width: 100,
        height: 100,
        checksumSha256: "0".repeat(64),
        position: i,
      });
    }

    const deleted: string[] = [];
    const envWithMedia = {
      ...env,
      MEDIA: {
        delete: (key: string) => {
          deleted.push(key);
          return Promise.resolve();
        },
      } as unknown as R2Bucket,
    };

    await requestAccountDeletion(db, user.id);
    await db
      .update(accountDeletionRequests)
      .set({ scheduledPurgeAt: new Date(Date.now() - 1000) })
      .where(eq(accountDeletionRequests.userId, user.id));

    const result = await purgeDueAccounts({ db, env: envWithMedia, logger: testLogger });
    expect(result.purged).toBe(1);
    expect(deleted.sort()).toEqual(keys.sort());
    expect(await db.select().from(listingImages)).toHaveLength(0);
  });

  it("★R2 が消せない日はその人を見送る（DB を先に消さない）★", async () => {
    // DB を先に消すと、実体を辿る手段が二度と無くなる。明日また試す。
    const user = await makeUser(db, "purge-r2-down@example.test");
    const listingId = await makeDraft(db, user.id);
    await db.insert(listingImages).values({
      id: ulid(),
      listingId,
      objectKey: `listings/${listingId}/a`,
      contentType: "image/jpeg",
      byteSize: 1000,
      width: 100,
      height: 100,
      checksumSha256: "0".repeat(64),
    });
    const brokenMedia = {
      ...env,
      MEDIA: {
        delete: () => Promise.reject(new Error("R2 unavailable")),
      } as unknown as R2Bucket,
    };

    await requestAccountDeletion(db, user.id);
    await db
      .update(accountDeletionRequests)
      .set({ scheduledPurgeAt: new Date(Date.now() - 1000) })
      .where(eq(accountDeletionRequests.userId, user.id));

    const result = await purgeDueAccounts({ db, env: brokenMedia, logger: testLogger });
    expect(result.purged).toBe(0);
    expect(result.failed).toBe(1);
    // 本人も投稿も残っている（明日やり直せる）。
    expect(
      await db.select({ id: users.id }).from(users).where(eq(users.id, user.id)),
    ).toHaveLength(1);
    expect(await db.select().from(listingImages)).toHaveLength(1);
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

/**
 * 定期処理の入口。
 *
 * ★この経路は「書いてあるのに1度も走っていなかった」ものなので、
 * 入口から実際に呼んで確かめる。★ 個々の削除関数だけを検査していると、
 * 呼び出す側が壊れていることに気づけない（実際そうなっていた。
 * scripts/cron.ts は `~/` 別名を読めず起動すらしなかった）。
 */
describe("★定期処理が入口から実際に走る★", () => {
  it("日次で、退会の実削除と発信者情報の削除が呼ばれる", async () => {
    const db = await resetDatabase();
    const user = await makeUser(db, "cron-target@example.test");

    // 退会を依頼し、予定日を過去にずらして「30日を過ぎた」状態にする。
    await requestAccountDeletion(db, user.id);
    await db
      .update(accountDeletionRequests)
      .set({ scheduledPurgeAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(accountDeletionRequests.userId, user.id));

    /*
     * バックアップは毎日走る（2026-08-18〜。DB 側に時点復旧が無いため）ので、
     * R2 の代わりを渡す。書き出しの中身は backup.test.ts が見ている。
     * ★日付も必ず渡す。★ 省くと実行した日で結果が変わる検査になりうる
     * （週1回だった頃、月曜だけ落ちるテストを実際に踏んだ）。
     */
    const stored = new Map<string, string>();
    const backups = {
      put: (key: string, body: string) => {
        stored.set(key, body);
        return Promise.resolve(undefined);
      },
      list: () =>
        Promise.resolve({ objects: [...stored.keys()].map((key) => ({ key })) }),
      delete: (key: string) => {
        stored.delete(key);
        return Promise.resolve(undefined);
      },
    } as unknown as R2Bucket;
    const result = await runScheduledTasks({
      cron: CRON_DAILY,
      db,
      env: { ...testEnv(), BACKUPS: backups },
      logger: testLogger,
      now: new Date("2026-08-18T19:20:00Z"),
    });

    // ★"failed" が入っていないこと。★ 件数0と失敗は別物。
    for (const [name, value] of Object.entries(result)) {
      expect(value, `${name} が失敗している`).not.toBe("failed");
    }

    // 退会が実際に処理されたこと。
    expect(result.purgeAccounts).toBe(1);
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, user.id));
    expect(rows[0]).toBeUndefined();

    // 日次で回すものが全部呼ばれていること（増減したら気づけるように）。
    expect(Object.keys(result).sort()).toEqual([
      "exportDatabase",
      "markEndedImages",
      "notifyExpiring",
      "pruneBackups",
      "purgeAccessRecords",
      "purgeAccounts",
      // 認証まわりの監査ログ（auth.* / authz.*）だけを180日で消す。
      // 監査ログ全体は消さない（2026-08-28 に追加）。
      "purgeAuthAuditLogs",
      "purgeDeletedImages",
      "purgeEmailLogs",
      "purgeEndedListings",
      "purgeOldPayments",
      "purgeRateLimits",
      "purgeResolvedReports",
      "purgeSessions",
      "purgeTokens",
      "purgeWebhookEvents",
    ]);

    /*
     * ★写真の掃除は掲載の削除より先に走ること。★ 逆だと listing_images が
     * 連鎖削除され、R2 の実体だけが取り残される（課金対象が永久に残る）。
     * 並び順そのものを検査しておく。
     */
    const order = Object.keys(result);
    expect(order.indexOf("markEndedImages")).toBeLessThan(
      order.indexOf("purgeDeletedImages"),
    );
    expect(order.indexOf("purgeDeletedImages")).toBeLessThan(
      order.indexOf("purgeEndedListings"),
    );
  });

  it("1時間ごとでは掲載期限の反映と決済の突き合わせだけを行う", async () => {
    const db = await resetDatabase();

    const result = await runScheduledTasks({
      cron: CRON_HOURLY,
      db,
      env: testEnv(),
      logger: testLogger,
    });

    // 削除系がここに混ざっていないこと（毎時消しにいくことになる）。
    expect(Object.keys(result)).toEqual(["expireListings", "reconcilePayments"]);
    expect(result.expireListings).not.toBe("failed");
    expect(result.reconcilePayments).not.toBe("failed");
  });

  it("★1つ落ちても残りは走り、落ちたものは失敗として残る★", async () => {
    const db = await resetDatabase();

    /*
     * 本当に落ちる状況を作る。表を一時的に隠して、レート制限の掃除だけを
     * 失敗させる。★「対象0件で通っただけ」を成功と読み違えないため。★
     * finally で必ず戻す（戻し損ねると後続のテストが落ちて気づける）。
     */
    await db.execute(sql`alter table rate_limits rename to rate_limits_hidden`);
    let result;
    try {
      result = await runScheduledTasks({
        cron: CRON_DAILY,
        db,
        env: testEnv(),
        logger: testLogger,
      });
    } finally {
      await db.execute(sql`alter table rate_limits_hidden rename to rate_limits`);
    }

    // 落ちたものは件数ではなく失敗として残る（0件と区別できること）。
    expect(result.purgeRateLimits).toBe("failed");

    // ★約束した削除は、他が落ちても必ず走っていること。★
    expect(result.purgeAccounts).not.toBe("failed");
    expect(result.purgeAccessRecords).not.toBe("failed");
    expect(result.purgeSessions).not.toBe("failed");
  });
});
