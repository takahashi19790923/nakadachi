import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { accessRecords,
  adminActions,
  auditLogs,
} from "~/db/schema/index.ts";
import type { Db } from "~/server/db.server";
import {
  disclosureForTarget,
  disclosureForUser,
  purgeExpiredAccessRecords,
  recordAccess,
} from "~/server/services/access-record-service.server";
import {
  closeTestDb,
  makeUser,
  resetDatabase,
  testEnv,
  testLogger,
} from "./helpers.ts";

/**
 * 発信者情報の記録。
 *
 * ★これが無いと、詐欺の被害者からの開示請求にも警察の照会にも答えられない。★
 * プライバシーポリシーには「法令に基づく正当な手続きにより開示を求められた
 * 場合」に開示すると書いてある。書いてあることを実行できる状態を保つ。
 */
let db: Db;
const env = testEnv();

function req(ip: string | null, ua = "test-agent"): Request {
  const headers: Record<string, string> = { "user-agent": ua };
  if (ip) headers["cf-connecting-ip"] = ip;
  return new Request("https://nakadachi.rewrite-co.com/listings/x/checkout", {
    method: "POST",
    headers,
  });
}

beforeEach(async () => {
  db = await resetDatabase();
});

afterAll(async () => {
  await closeTestDb();
});

describe("発信者情報の記録", () => {
  it("★IPは生では保存されない（暗号文になっている）★", async () => {
    const user = await makeUser(db, "seller@example.test");
    await recordAccess({
      db,
      env,
      logger: testLogger,
      request: req("203.0.113.42"),
      action: "listing_published",
      userId: user.id,
      targetType: "listing",
      targetId: "01TESTLISTING000000000000",
    });

    const rows = await db.select().from(accessRecords);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ipEncrypted).not.toContain("203.0.113.42");
    expect(rows[0]!.ipHmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("★復号すると元のIPに戻る（開示できる）★", async () => {
    const admin = await makeUser(db, "admin2@example.test", "admin");
    const user = await makeUser(db, "seller2@example.test");
    await recordAccess({
      db,
      env,
      logger: testLogger,
      request: req("198.51.100.7"),
      action: "listing_published",
      userId: user.id,
      targetType: "listing",
      targetId: "01TESTLISTING000000000001",
    });

    const records = await disclosureForUser({
      db,
      env,
      userId: user.id,
      actor: { adminId: admin.id, reason: "検査" },
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.ip).toBe("198.51.100.7");
    expect(records[0]!.userAgent).toBe("test-agent");
    expect(records[0]!.action).toBe("listing_published");
  });

  it("特定の投稿がどこから行われたかを引ける", async () => {
    const admin = await makeUser(db, "admin3@example.test", "admin");
    const user = await makeUser(db, "seller3@example.test");
    const listingId = "01TESTLISTING000000000002";
    for (const ip of ["203.0.113.1", "203.0.113.2"]) {
      await recordAccess({
        db,
        env,
        logger: testLogger,
        request: req(ip),
        action: "listing_published",
        userId: user.id,
        targetType: "listing",
        targetId: listingId,
      });
    }

    const records = await disclosureForTarget({
      db,
      env,
      targetType: "listing",
      targetId: listingId,
      actor: { adminId: admin.id, reason: "検査" },
    });
    expect(records.map((r) => r.ip).sort()).toEqual([
      "203.0.113.1",
      "203.0.113.2",
    ]);
  });

  it("同じIPからの操作は索引で束ねられる", async () => {
    const a = await makeUser(db, "a@example.test");
    const b = await makeUser(db, "b@example.test");
    for (const userId of [a.id, b.id]) {
      await recordAccess({
        db,
        env,
        logger: testLogger,
        request: req("203.0.113.99"),
        action: "signup",
        userId,
      });
    }

    const rows = await db.select().from(accessRecords);
    // 暗号文は毎回変わるが、索引は同じ。別アカウントの同一IP利用を追える。
    expect(new Set(rows.map((r) => r.ipEncrypted)).size).toBe(2);
    expect(new Set(rows.map((r) => r.ipHmac)).size).toBe(1);
  });

  it("★記録に失敗しても例外を投げない（本体の操作を巻き戻さない）★", async () => {
    const user = await makeUser(db, "c@example.test");
    // 鍵が無い状態。投稿は成立しているのに記録の失敗で全部戻るのが最悪。
    await expect(
      recordAccess({
        db,
        env: { ...env, ACCESS_LOG_KEY: undefined },
        logger: testLogger,
        request: req("203.0.113.5"),
        action: "signup",
        userId: user.id,
      }),
    ).resolves.toBeUndefined();
    expect(await db.select().from(accessRecords)).toHaveLength(0);
  });

  it("Cloudflare を通っていない要求は記録しない", async () => {
    await recordAccess({
      db,
      env,
      logger: testLogger,
      request: req(null),
      action: "login",
      userId: null,
    });
    expect(await db.select().from(accessRecords)).toHaveLength(0);
  });
});

describe("保存期間", () => {
  it("★期限を過ぎたものは消える／期限内は残る★", async () => {
    const user = await makeUser(db, "d@example.test");
    await recordAccess({
      db,
      env,
      logger: testLogger,
      request: req("203.0.113.10"),
      action: "login",
      userId: user.id,
    });

    // まだ消えない
    expect(await purgeExpiredAccessRecords(db)).toBe(0);

    // 期限を過去にする
    await db
      .update(accessRecords)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(accessRecords.userId, user.id));

    expect(await purgeExpiredAccessRecords(db)).toBe(1);
    expect(await db.select().from(accessRecords)).toHaveLength(0);
  });

  it("★保存期間は6か月（プライバシーポリシーの記載と一致させる）★", async () => {
    const user = await makeUser(db, "e@example.test");
    const before = Date.now();
    await recordAccess({
      db,
      env,
      logger: testLogger,
      request: req("203.0.113.11"),
      action: "login",
      userId: user.id,
    });

    const rows = await db.select().from(accessRecords);
    const days = (rows[0]!.expiresAt.getTime() - before) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(182);
    expect(days).toBeLessThan(184);
  });
});

/**
 * 発信者情報を引いた事実が、必ず記録に残ること。
 *
 * ★プライバシーポリシーで「参照した事実は記録に残します」と
 * 約束している当のもの。★
 *
 * 2026-08-25 の公開前監査の時点では、
 *   - 記録を183日ぶん、復号できる形で持っていた
 *   - 取り出す関数はあったが、呼ぶ側が1つも存在しなかった
 *   - 「記録を残すこと」は関数のコメントに書いてあるだけだった
 * という状態だった。★注意書きで守られている約束は、守られていない。★
 *
 * いまは記録を関数の中に入れてある。復号より先に書き、書けなければ
 * 復号もしない。つまり「記録の無い参照」は起こりえない。
 */
describe("★引いた事実が必ず残る★", () => {
  async function setup() {
    const admin = await makeUser(db, `disc-admin@example.test`, "admin");
    const user = await makeUser(db, `disc-user@example.test`);
    await recordAccess({
      db,
      env,
      logger: testLogger,
      request: req("198.51.100.42"),
      action: "listing_published",
      userId: user.id,
      targetType: "listing",
      targetId: "01TESTLISTING000000000009",
    });
    return { admin, user };
  }

  async function disclosureRecords() {
    const audits = await db
      .select({ action: auditLogs.action, actorId: auditLogs.actorId })
      .from(auditLogs)
      .where(eq(auditLogs.action, "admin.disclosure_viewed"));
    const admins = await db
      .select({ reason: adminActions.reason, adminId: adminActions.adminId })
      .from(adminActions)
      .where(eq(adminActions.actionType, "disclosure_view"));
    return { audits, admins };
  }

  it("利用者から引くと、監査ログと管理操作の両方に残る", async () => {
    const { admin, user } = await setup();

    const records = await disclosureForUser({
      db,
      env,
      userId: user.id,
      actor: { adminId: admin.id, reason: "○○署からの捜査関係事項照会" },
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.ip).toBe("198.51.100.42");

    const { audits, admins } = await disclosureRecords();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(admin.id);
    expect(admins).toHaveLength(1);
    expect(admins[0]!.adminId).toBe(admin.id);
    // ★理由が残っていること。★ あとから判断の当否を確かめるために要る。
    expect(admins[0]!.reason).toContain("捜査関係事項照会");
  });

  it("★理由が無ければ、そもそも復号しない★", async () => {
    const { admin, user } = await setup();

    for (const reason of ["", "   "]) {
      await expect(
        disclosureForUser({
          db,
          env,
          userId: user.id,
          actor: { adminId: admin.id, reason },
        }),
      ).rejects.toThrow();
    }

    // 記録も残らない（＝復号まで到達していない）。
    const { audits, admins } = await disclosureRecords();
    expect(audits).toHaveLength(0);
    expect(admins).toHaveLength(0);
  });

  it("対象から引く場合も同じ", async () => {
    const { admin } = await setup();

    await disclosureForTarget({
      db,
      env,
      targetType: "listing",
      targetId: "01TESTLISTING000000000009",
      actor: { adminId: admin.id, reason: "重大な不正の調査" },
    });

    const { audits, admins } = await disclosureRecords();
    expect(audits).toHaveLength(1);
    expect(admins[0]!.reason).toContain("不正");
  });

  it("引くたびに1件ずつ増える（まとめて1件にしない）", async () => {
    const { admin, user } = await setup();
    const actor = { adminId: admin.id, reason: "確認" };

    await disclosureForUser({ db, env, userId: user.id, actor });
    await disclosureForUser({ db, env, userId: user.id, actor });

    const { audits } = await disclosureRecords();
    expect(audits).toHaveLength(2);
  });
});
