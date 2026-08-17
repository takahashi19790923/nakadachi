import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "~/server/db.server";
import type { AppEnv } from "~/server/env.server";
import { CRON_DAILY, runScheduledTasks } from "~/server/cron.server";
import {
  exportDatabase,
  pruneOldBackups,
} from "~/server/services/backup-service.server";
import {
  closeTestDb,
  makeDraft,
  makeUser,
  resetDatabase,
  testEnv,
  testLogger,
} from "./helpers.ts";

/**
 * DB の書き出し。
 *
 * ★実際の DB へ当てる。★ 表の綴り・並び順・空の表の扱いは、
 * 実行して初めて分かる。R2 だけを模擬に差し替える。
 */
let db: Db;

/** R2 の代わり。put/list/delete だけを持つ */
function fakeBucket() {
  const objects = new Map<string, string>();
  return {
    objects,
    binding: {
      put: (key: string, body: string) => {
        objects.set(key, body);
        return Promise.resolve(undefined);
      },
      list: (options?: { prefix?: string }) =>
        Promise.resolve({
          objects: [...objects.keys()]
            .filter((k) => !options?.prefix || k.startsWith(options.prefix))
            .map((key) => ({ key })),
        }),
      delete: (key: string) => {
        objects.delete(key);
        return Promise.resolve(undefined);
      },
    } as unknown as R2Bucket,
  };
}

function envWith(bucket: R2Bucket): AppEnv {
  return { ...testEnv(), BACKUPS: bucket };
}

beforeEach(async () => {
  db = await resetDatabase();
});

afterAll(async () => {
  await closeTestDb();
});

describe("DB の書き出し", () => {
  it("★全部の表を書き出し、中身が読み戻せる★", async () => {
    const user = await makeUser(db, "backup@example.test");
    const listingId = await makeDraft(db, user.id, { status: "published" });

    const { objects, binding } = fakeBucket();
    const result = await exportDatabase({
      db,
      env: envWith(binding),
      logger: testLogger,
      now: new Date("2026-08-17T00:00:00Z"),
    });

    expect(result.key).toBe("db/2026-08-17.json");
    expect(objects.size).toBe(1);

    // ★書き出したものが JSON として読めること。★ 壊れた写しは
    // 「あるのに使えない」といういちばん困る形になる。
    const parsed = JSON.parse(objects.get(result.key)!);
    expect(parsed.version).toBe(1);
    expect(parsed.environment).toBe("development");

    const byName = new Map<string, { rows: number; data: unknown[] }>(
      parsed.tables.map((t: { table: string; rows: number; data: unknown[] }) => [
        t.table,
        t,
      ]),
    );

    // 実データが入っていること。
    const listings = byName.get("listings")!;
    expect(listings.rows).toBe(1);
    expect((listings.data[0] as { id: string }).id).toBe(listingId);

    // 空の表も '[]' で入っていること（復旧側の分岐を増やさない）。
    expect(byName.get("payments")!.data).toEqual([]);
    expect(byName.get("payments")!.rows).toBe(0);

    // seed 済みの参照データも含むこと。
    expect(byName.get("locations")!.rows).toBeGreaterThan(0);
  });

  it("★復旧の順で並んでいる（親が子より先）★", async () => {
    const { objects, binding } = fakeBucket();
    const result = await exportDatabase({
      db,
      env: envWith(binding),
      logger: testLogger,
    });
    const parsed = JSON.parse(objects.get(result.key)!);
    const order: string[] = parsed.tables.map((t: { table: string }) => t.table);

    const before = (parent: string, child: string) => {
      expect(
        order.indexOf(parent),
        `${parent} は ${child} より先に並んでいること`,
      ).toBeLessThan(order.indexOf(child));
    };

    before("users", "listings");
    before("listings", "listing_images");
    before("listings", "payments");
    before("conversation_threads", "messages");
    before("categories", "listings");
  });

  it("BACKUPS が無ければ失敗する（黙って何もしない、にしない）", async () => {
    await expect(
      exportDatabase({ db, env: testEnv(), logger: testLogger }),
    ).rejects.toThrow(/BACKUPS/);
  });
});

describe("古い世代の掃除", () => {
  it("新しいほうから数えて残す", async () => {
    const { objects, binding } = fakeBucket();
    for (const day of ["01", "02", "03", "04", "05"]) {
      objects.set(`db/2026-08-${day}.json`, "{}");
    }
    // 関係ないキーは触らない。
    objects.set("other/thing.json", "{}");

    const removed = await pruneOldBackups({
      env: envWith(binding),
      logger: testLogger,
      keep: 2,
    });

    expect(removed).toBe(3);
    expect([...objects.keys()].sort()).toEqual([
      "db/2026-08-04.json",
      "db/2026-08-05.json",
      "other/thing.json",
    ]);
  });
});

describe("日次の中で毎日書き出す", () => {
  /** UTC 月曜 */
  const monday = new Date("2026-08-17T19:20:00Z");
  /** UTC 火曜 */
  const tuesday = new Date("2026-08-18T19:20:00Z");

  it("★月曜も書き出す★", async () => {
    const { objects, binding } = fakeBucket();
    const result = await runScheduledTasks({
      cron: CRON_DAILY,
      db,
      env: envWith(binding),
      logger: testLogger,
      now: monday,
    });

    expect(result.exportDatabase).not.toBe("failed");
    expect(objects.size).toBe(1);
    // 日次の掃除も同じ回で走っていること。
    expect(result.purgeAccounts).not.toBe("failed");
  });

  it("★月曜以外も書き出す（DB 側に時点復旧が無いので毎日）★", async () => {
    // 以前は週1回（月曜だけ）。Supabase Free には PITR もバックアップも無いので毎日にした。
    const { objects, binding } = fakeBucket();
    const result = await runScheduledTasks({
      cron: CRON_DAILY,
      db,
      env: envWith(binding),
      logger: testLogger,
      now: tuesday,
    });

    expect(result.exportDatabase).not.toBe("failed");
    expect(objects.size).toBe(1);
    expect(result.purgeAccounts).not.toBe("failed");
  });

  it("★消す処理より先に書き出す★", async () => {
    /*
     * 日次の後半は全部「消す」処理。消したあとに書き出すと、その日の
     * バックアップからは消したものが失われている。取り戻したいのは
     * 消える前の状態のほう。
     */
    const { binding } = fakeBucket();
    const result = await runScheduledTasks({
      cron: CRON_DAILY,
      db,
      env: envWith(binding),
      logger: testLogger,
      now: monday,
    });

    const order = Object.keys(result);
    expect(order.indexOf("exportDatabase")).toBeLessThan(
      order.indexOf("purgeAccounts"),
    );
    expect(order.indexOf("exportDatabase")).toBeLessThan(
      order.indexOf("purgeEndedListings"),
    );
  });

  it("★書き出しに失敗した週は古い世代を消さない★", async () => {
    // 消してから失敗すると、手元に何も残らない回ができる。
    const { objects, binding } = fakeBucket();
    objects.set("db/2026-01-01.json", "{}");
    const broken = {
      ...binding,
      put: () => Promise.reject(new Error("R2 unavailable")),
    } as unknown as R2Bucket;

    const result = await runScheduledTasks({
      cron: CRON_DAILY,
      db,
      env: envWith(broken),
      logger: testLogger,
      now: monday,
    });

    expect(result.exportDatabase).toBe("failed");
    expect(result.pruneBackups).toBeUndefined();
    expect(objects.size).toBe(1);
    // ★書き出しが落ちても、約束した削除は走ること。★
    expect(result.purgeAccounts).not.toBe("failed");
  });
});
