import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { emailDeliveryLogs, users } from "~/db/schema/index.ts";
import type { Db } from "~/server/db.server";
import { notifyExpiringListings } from "~/server/services/notification-service.server";
import {
  closeTestDb,
  makeDraft,
  makeUser,
  resetDatabase,
  testEnv,
  testLogger,
} from "./helpers.ts";

/**
 * 掲載期限が近いことの通知。
 *
 * ★1人の不具合で全員分が止まっていた。★
 * 宛先のメールアドレスを1人でも復号できないと、そこで例外になり、
 * その日に送るはずだった全員分の通知が止まっていた。preview で
 * 2026-09-10〜12 に実際に起きた（デモの利用者だけ別の鍵で暗号化されていた）。
 */
let db: Db;
/*
 * ★外へ送らない。★ testEnv() はダミーの鍵を持っているので、そのままだと
 * 毎回 api.resend.com へ POST する。鍵を外すと sendEmail は送らずに行だけ作る。
 */
const env = { ...testEnv(), RESEND_API_KEY: undefined };

beforeEach(async () => {
  db = await resetDatabase();
});

afterAll(async () => {
  await closeTestDb();
});

/** あと days 日で期限を迎える公開中の投稿 */
async function publishedExpiringIn(ownerId: string, days: number): Promise<string> {
  const listingId = await makeDraft(db, ownerId);
  await db.execute(sql`
    update listings
       set status = 'published',
           published_at = now() - interval '27 days',
           expires_at = now() + make_interval(days => ${days})
     where id = ${listingId}
  `);
  return listingId;
}

async function expiringNotices() {
  return db
    .select({ listingId: emailDeliveryLogs.listingId })
    .from(emailDeliveryLogs)
    .where(eq(emailDeliveryLogs.template, "listing_expiring"));
}

describe("★期限通知は、1人の不具合で全員分を止めない★", () => {
  it("復号できない宛先があっても、他の人には送る", async () => {
    const broken = await makeUser(db, "broken@example.test");
    const healthy = await makeUser(db, "healthy@example.test");
    await db
      .update(users)
      .set({ emailEncrypted: "これは暗号文ではない" })
      .where(eq(users.id, broken.id));

    await publishedExpiringIn(broken.id, 2);
    const healthyListing = await publishedExpiringIn(healthy.id, 2);

    // ★失敗は «失敗» として返す。★ 黙ると毎日届いていないことに気づけない。
    await expect(
      notifyExpiringListings({ db, env, logger: testLogger }),
    ).rejects.toThrow(/failed: 1 of 2/);

    // ★それでも健全な人には届いている。★
    const sent = await expiringNotices();
    expect(sent.map((r) => r.listingId)).toEqual([healthyListing]);
  });

  it("全員が健全なら、例外を出さずに件数を返す", async () => {
    const a = await makeUser(db, "a@example.test");
    const b = await makeUser(db, "b@example.test");
    await publishedExpiringIn(a.id, 2);
    await publishedExpiringIn(b.id, 1);

    // 例外を出さないこと。届いたかは記録の行で見る（件数の戻り値は
    // 鍵が無いと 0 なので、それだけでは «送れた» を示さない）。
    await notifyExpiringListings({ db, env, logger: testLogger });
    expect(await expiringNotices()).toHaveLength(2);
  });

  it("期限までまだ遠いものには送らない", async () => {
    const a = await makeUser(db, "far@example.test");
    await publishedExpiringIn(a.id, 10);

    await notifyExpiringListings({ db, env, logger: testLogger });
    expect(await expiringNotices()).toHaveLength(0);
  });
});
