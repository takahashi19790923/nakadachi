import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { locations } from "~/db/schema/index.ts";
import {
  clearLocationCache,
  getLocation,
  isValidAreaPair,
  listCities,
  listPrefectures,
} from "~/server/repositories/location-repository.server";

import {
  HANDOVER_METHODS,
  ITEM_CONDITIONS,
  LISTING_KINDS,
  PRICE_TYPES,
  PRICE_UNITS,
} from "~/domain/categories";
import { LISTING_STATUSES } from "~/domain/listing-status";
import type { Db } from "~/server/db.server";
import { closeTestDb, resetDatabase } from "./helpers.ts";

/**
 * スキーマそのものの検査。
 *
 * ★TypeScript の定数と DB の enum が一致していることを、実際の DB に
 * 問い合わせて確かめる。★ 選択肢を増やしたのに DB を直し忘れると、
 * 型検査もテストも緑のまま本番の INSERT だけが落ちる。
 */
let db: Db;

beforeAll(async () => {
  db = await resetDatabase();
});

afterAll(async () => {
  await closeTestDb();
});

async function enumValues(typeName: string): Promise<string[]> {
  const result = await db.execute<{ value: string }>(sql`
    select e.enumlabel as value
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = ${typeName}
    order by e.enumsortorder
  `);
  return result.rows.map((row) => row.value);
}

describe("DB の enum と TypeScript の定数が一致する", () => {
  it("listing_status", async () => {
    expect(await enumValues("listing_status")).toEqual([...LISTING_STATUSES]);
  });

  it("listing_kind", async () => {
    expect(await enumValues("listing_kind")).toEqual([...LISTING_KINDS]);
  });

  it("price_type", async () => {
    expect(await enumValues("price_type")).toEqual([...PRICE_TYPES]);
  });

  it("price_unit", async () => {
    expect(await enumValues("price_unit")).toEqual([...PRICE_UNITS]);
  });

  it("item_condition", async () => {
    expect(await enumValues("item_condition")).toEqual([...ITEM_CONDITIONS]);
  });

  it("handover_method", async () => {
    expect(await enumValues("handover_method")).toEqual([...HANDOVER_METHODS]);
  });
});

describe("拡張と索引", () => {
  it("★pg_trgm が入っている★（キーワード検索の前提）", async () => {
    const result = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from pg_extension where extname = 'pg_trgm'`,
    );
    expect(Number(result.rows[0]?.count)).toBe(1);
  });

  it("検索用の GIN 索引が作られている", async () => {
    const result = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where indexname = 'listings_search_text_trgm_idx'`,
    );
    expect(result.rows).toHaveLength(1);
  });

  it("search_text は生成列で、タイトルと本文から作られる", async () => {
    const result = await db.execute<{ is_generated: string }>(sql`
      select is_generated from information_schema.columns
      where table_name = 'listings' and column_name = 'search_text'
    `);
    expect(result.rows[0]?.is_generated).toBe("ALWAYS");
  });
});

describe("一意制約（二重処理を防ぐ最後の砦）", () => {
  async function hasUniqueIndex(name: string): Promise<boolean> {
    const result = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from pg_indexes
      where indexname = ${name}
    `);
    return Number(result.rows[0]?.count) === 1;
  }

  it("Checkout Session ID に一意制約がある（二重課金を防ぐ）", async () => {
    expect(await hasUniqueIndex("payments_checkout_session_id_key")).toBe(true);
  });

  it("Webhook イベント ID に一意制約がある（二重処理を防ぐ）", async () => {
    expect(await hasUniqueIndex("pwe_provider_event_id_key")).toBe(true);
  });

  it("メールアドレスの索引に一意制約がある（二重登録を防ぐ）", async () => {
    expect(await hasUniqueIndex("users_email_hmac_key")).toBe(true);
  });

  it("会話スレッドは投稿と問い合わせ者の組で1本", async () => {
    expect(await hasUniqueIndex("threads_listing_initiator_key")).toBe(true);
  });

  it("メール送信の冪等キーに一意制約がある", async () => {
    expect(await hasUniqueIndex("edl_idempotency_key")).toBe(true);
  });
});

describe("金額の型", () => {
  it("★浮動小数点で保存していない★", async () => {
    const result = await db.execute<{ column_name: string; data_type: string }>(sql`
      select column_name, data_type from information_schema.columns
      where table_name in ('listings', 'payments', 'listing_category_details')
        and column_name like '%jpy%'
    `);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.data_type).toBe("integer");
    }
  });
});

describe("監査ログの独立性", () => {
  it("★audit_logs は users への外部キーを持たない★（記録ごと消えないように）", async () => {
    const result = await db.execute<{ count: number }>(sql`
      select count(*)::int as count
      from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu
        on tc.constraint_name = ccu.constraint_name
      where tc.table_name = 'audit_logs'
        and tc.constraint_type = 'FOREIGN KEY'
    `);
    expect(Number(result.rows[0]?.count)).toBe(0);
  });
});

describe("seed", () => {
  it("47都道府県が入る", async () => {
    const result = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from locations where kind = 'prefecture'`,
    );
    expect(Number(result.rows[0]?.count)).toBe(47);
  });

  it("すべての都道府県に少なくとも1つの市区町村がある", async () => {
    const result = await db.execute<{ code: string }>(sql`
      select p.code from locations p
      where p.kind = 'prefecture'
        and not exists (
          select 1 from locations c where c.kind = 'city' and c.parent_code = p.code
        )
    `);
    expect(result.rows).toEqual([]);
  });

  it("5つのカテゴリが入る", async () => {
    const result = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from categories`,
    );
    expect(Number(result.rows[0]?.count)).toBe(5);
  });

  it("★何度流しても増えない（冪等）★", async () => {
    const before = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from locations`,
    );
    await resetDatabase();
    const after = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from locations`,
    );
    expect(after.rows[0]?.count).toEqual(before.rows[0]?.count);
  });
});

/**
 * 地域データの読み出し。
 *
 * ★参照データをアイソレート内に持ち回るようにした。★ 1往復あたり
 * 100〜250ms かかる環境なので、地域ページや投稿フォームで効く。
 * 持ち回る以上、「古い値を返さないこと」と「絞り方を間違えないこと」を
 * ここで見張る。
 */
describe("地域データ", () => {
  it("一覧には有効なものだけ、個別取得では無効なものも引ける", async () => {
    const db = await resetDatabase();

    const before = await listPrefectures(db);
    expect(before.length).toBeGreaterThan(0);
    const target = before[0]!;

    // 使われなくなった地域は削除せず isActive を落とす運用。
    await db
      .update(locations)
      .set({ isActive: false })
      .where(eq(locations.code, target.code));
    clearLocationCache();

    const after = await listPrefectures(db);
    expect(after.some((row) => row.code === target.code)).toBe(false);

    /*
     * ★個別取得では引けること。★ ここで null にすると、その地域を
     * 参照している過去の投稿の画面が開けなくなる。
     */
    const single = await getLocation(db, target.code);
    expect(single?.code).toBe(target.code);
  });

  it("キャッシュを捨てれば、入れ替えた内容がすぐ反映される", async () => {
    const db = await resetDatabase();
    const first = await listPrefectures(db);
    expect(first.length).toBeGreaterThan(0);

    // 捨てずに DB だけ変えると古い内容が返る（持ち回っているので当然）。
    await db.delete(locations).where(eq(locations.kind, "city"));
    await db.delete(locations).where(eq(locations.kind, "prefecture"));

    clearLocationCache();
    const afterClear = await listPrefectures(db);
    expect(afterClear).toHaveLength(0);
  });

  it("市区町村と都道府県の対応を、組み合わせの検査で使える", async () => {
    const db = await resetDatabase();
    const prefectures = await listPrefectures(db);
    const prefecture = prefectures[0]!;
    const cities = await listCities(db, prefecture.code);
    expect(cities.length).toBeGreaterThan(0);

    expect(await isValidAreaPair(db, prefecture.code, cities[0]!.code)).toBe(true);
    // 別の都道府県の下にある市区町村は通さない（URL を並べ替えただけの
    // ページを量産させない）。
    const other = prefectures.find((p) => p.code !== prefecture.code)!;
    expect(await isValidAreaPair(db, other.code, cities[0]!.code)).toBe(false);
  });
});
