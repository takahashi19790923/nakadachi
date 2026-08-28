import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { listings, payments } from "~/db/schema/index.ts";
import type { Db } from "~/server/db.server";
import {
  markAbandonedDraftImages,
  purgeAbandonedDrafts,
} from "~/server/services/retention-service.server";

import {
  closeTestDb,
  makeDraft,
  makeUser,
  resetDatabase,
} from "./helpers.ts";

/**
 * 一度も公開されなかった下書きの掃除。
 *
 * ★これまで誰も消していなかった。★ 期限切れの掃除は「終わった掲載」
 * （closed / expired / rejected …）しか見ておらず、draft は
 * 「終わっていない」ので永久に残っていた。写真も R2 に残り続ける。
 *
 * ★消しすぎるほうが怖い。★ 払ったのに消えた・公開したのに消えた、を
 * 作らないよう、除外の条件を一つずつ検査する。
 */
let db: Db;
const OLD = 200; // 保持期間(180日)より古い
const RECENT = 10;

async function age(listingId: string, days: number) {
  await db.execute(sql`
    update listings
    set updated_at = now() - make_interval(days => ${days})
    where id = ${listingId}
  `);
}

async function exists(listingId: string): Promise<boolean> {
  const rows = await db
    .select({ id: listings.id })
    .from(listings)
    .where(eq(listings.id, listingId));
  return rows.length > 0;
}

describe("放置された下書きの掃除", () => {
  beforeEach(async () => {
    db = await resetDatabase();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("★古い下書きは消える★", async () => {
    const user = await makeUser(db, "abandon@example.test");
    const id = await makeDraft(db, user.id);
    await age(id, OLD);

    expect(await purgeAbandonedDrafts(db)).toBe(1);
    expect(await exists(id)).toBe(false);
  });

  it("新しい下書きは消さない（書きかけを保存している人がいる）", async () => {
    const user = await makeUser(db, "recent@example.test");
    const id = await makeDraft(db, user.id);
    await age(id, RECENT);

    expect(await purgeAbandonedDrafts(db)).toBe(0);
    expect(await exists(id)).toBe(true);
  });

  it("★決済が動いているものは消さない★（払ったのに消えた、を作らない）", async () => {
    const user = await makeUser(db, "paid@example.test");

    for (const status of ["created", "pending", "succeeded"] as const) {
      const id = await makeDraft(db, user.id);
      await age(id, OLD);
      await db.insert(payments).values({
        id: `01PAY${status.toUpperCase().padEnd(21, "0")}`.slice(0, 26),
        listingId: id,
        userId: user.id,
        provider: "stripe",
        checkoutSessionId: `cs_test_${status}`,
        amountJpy: 110,
        currency: "jpy",
        status,
      });

      expect(await purgeAbandonedDrafts(db), status).toBe(0);
      expect(await exists(id), status).toBe(true);
    }
  });

  it("★一度でも公開されたものは消さない★", async () => {
    const user = await makeUser(db, "was-public@example.test");
    const id = await makeDraft(db, user.id);
    await age(id, OLD);
    // いまは draft でも、公開された履歴があるなら別の保持期間の話。
    await db
      .update(listings)
      .set({ publishedAt: new Date(Date.now() - 300 * 24 * 60 * 60 * 1000) })
      .where(eq(listings.id, id));

    expect(await purgeAbandonedDrafts(db)).toBe(0);
    expect(await exists(id)).toBe(true);
  });

  it("公開中・掲載終了のものは触らない（別の掃除の担当）", async () => {
    const user = await makeUser(db, "other-status@example.test");
    for (const status of ["published", "closed"] as const) {
      const id = await makeDraft(db, user.id, { status });
      await age(id, OLD);
      expect(await purgeAbandonedDrafts(db), status).toBe(0);
      expect(await exists(id), status).toBe(true);
    }
  });

  it("写真の印つけも同じ条件で絞られる", async () => {
    const user = await makeUser(db, "img@example.test");
    const paid = await makeDraft(db, user.id);
    await age(paid, OLD);
    await db.insert(payments).values({
      id: "01PAYIMG00000000000000000",
      listingId: paid,
      userId: user.id,
      provider: "stripe",
      checkoutSessionId: "cs_test_img",
      amountJpy: 110,
      currency: "jpy",
      status: "succeeded",
    });

    // 決済のあるものは、写真にも印をつけない。
    expect(await markAbandonedDraftImages(db)).toBe(0);
  });
});
