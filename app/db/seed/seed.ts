import { sql } from "drizzle-orm";

import { CATEGORY_LIST } from "../../domain/categories.ts";
import { ulid } from "../../domain/ulid.ts";
import { bannedWords, categories, locations } from "../schema/index.ts";
import type { Db } from "../../server/db.server.ts";
import { CITIES, PREFECTURES, otherCityFor } from "./locations.ts";

/**
 * 初期データの投入。
 *
 * ★何度流しても同じ結果になるようにする（冪等）。★ 本番で追加分だけを
 * 入れ直したいことがあるため、既にある行は更新し、消さない。
 * ★行を削除しないこと。★ 過去の投稿が地域コードを参照している。
 */
export async function seedAll(db: Db): Promise<{
  categories: number;
  prefectures: number;
  cities: number;
  bannedWords: number;
}> {
  const categoryCount = await seedCategories(db);
  const { prefectures, cities } = await seedLocations(db);
  const wordCount = await seedBannedWords(db);
  return {
    categories: categoryCount,
    prefectures,
    cities,
    bannedWords: wordCount,
  };
}

/**
 * カテゴリ。
 * 定義そのものは app/domain/categories.ts にあり、ここは行を作るだけ。
 * 両方に選択肢を書き写すと、必ずどちらかがずれる。
 */
async function seedCategories(db: Db): Promise<number> {
  await db
    .insert(categories)
    .values(
      CATEGORY_LIST.map((category, index) => ({
        id: ulid(),
        slug: category.slug,
        name: category.name,
        description: category.description,
        sortOrder: index,
        isActive: true,
      })),
    )
    .onConflictDoUpdate({
      target: categories.slug,
      // ★衝突した行の新しい値は excluded から取る。★ 1文にまとめた以上、
      // ここに定数を書くと全行が最後の1件で上書きされる。
      set: {
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        sortOrder: sql`excluded.sort_order`,
        isActive: true,
        updatedAt: new Date(),
      },
    });
  return CATEGORY_LIST.length;
}

async function seedLocations(
  db: Db,
): Promise<{ prefectures: number; cities: number }> {
  await db
    .insert(locations)
    .values(
      PREFECTURES.map((prefecture, order) => ({
        id: ulid(),
        code: prefecture.code,
        kind: "prefecture" as const,
        parentCode: null,
        name: prefecture.name,
        kana: prefecture.kana,
        romaji: prefecture.romaji,
        sortOrder: order,
        isActive: true,
      })),
    )
    .onConflictDoUpdate({
      target: locations.code,
      set: {
        name: sql`excluded.name`,
        kana: sql`excluded.kana`,
        romaji: sql`excluded.romaji`,
        sortOrder: sql`excluded.sort_order`,
        updatedAt: new Date(),
      },
    });

  // 収録済みの市区町村と、各都道府県の「その他」を入れる。
  const allCities = [
    ...CITIES,
    ...PREFECTURES.map((prefecture) => otherCityFor(prefecture.code)),
  ];

  await db
    .insert(locations)
    .values(
      allCities.map((city, cityOrder) => ({
        id: ulid(),
        code: city.code,
        kind: "city" as const,
        parentCode: city.parentCode,
        name: city.name,
        sortOrder: cityOrder,
        isActive: true,
      })),
    )
    .onConflictDoUpdate({
      target: locations.code,
      set: {
        name: sql`excluded.name`,
        parentCode: sql`excluded.parent_code`,
        sortOrder: sql`excluded.sort_order`,
        updatedAt: new Date(),
      },
    });

  return { prefectures: PREFECTURES.length, cities: allCities.length };
}

/**
 * 禁止ワードの初期値。
 *
 * ★ここに露骨な語を並べない。★ リポジトリは公開されうるし、
 * 差別的な語の一覧を持つこと自体が問題になる。運用のなかで
 * 管理画面から足していく前提で、明確に違法・危険な取引を示す語だけを置く。
 *
 * ★これだけで守れるとは考えないこと。★ 表記ゆれで簡単にすり抜ける。
 * 通報と管理者の目視と併用する前提の、最初の網でしかない。
 */
const INITIAL_BANNED_WORDS: readonly {
  word: string;
  severity: "block" | "flag";
  note: string;
}[] = [
  { word: "口座売ります", severity: "block", note: "銀行口座の譲渡は犯罪収益移転防止法違反" },
  { word: "口座買います", severity: "block", note: "同上" },
  { word: "銀行口座譲渡", severity: "block", note: "同上" },
  { word: "キャッシュカード譲渡", severity: "block", note: "同上" },
  { word: "携帯名義貸し", severity: "block", note: "携帯電話不正利用防止法違反" },
  { word: "闇バイト", severity: "block", note: "犯罪実行者の募集" },
  { word: "受け子", severity: "block", note: "同上" },
  { word: "出し子", severity: "block", note: "同上" },
  { word: "叩き", severity: "flag", note: "強盗の隠語として使われることがある" },
  { word: "高額報酬即日", severity: "flag", note: "闇バイトの常套句" },
  { word: "誰でも簡単に稼げる", severity: "flag", note: "同上" },
  { word: "handwork", severity: "flag", note: "違法薬物取引の隠語" },
  { word: "手押し", severity: "flag", note: "同上" },
  { word: "野菜取引", severity: "flag", note: "同上（食品の正当な出品は誤検知になるため flag）" },
];

async function seedBannedWords(db: Db): Promise<number> {
  await db
    .insert(bannedWords)
    .values(
      INITIAL_BANNED_WORDS.map((entry) => ({
        id: ulid(),
        // 照合と同じ正規化をかけてから入れる。
        word: entry.word.normalize("NFKC").toLowerCase(),
        severity: entry.severity,
        note: entry.note,
      })),
    )
    .onConflictDoNothing({ target: bannedWords.word });
  return INITIAL_BANNED_WORDS.length;
}

/**
 * 統合テスト用。全テーブルを空にする。
 *
 * ★本番の接続文字列で絶対に呼ばないこと。★ 呼び出し側で
 * TEST_DATABASE_URL を確かめている（scripts/reset-test-db が担当）。
 */
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql`
    truncate table
      access_records,
      audit_logs, admin_actions, email_delivery_logs, rate_limits,
      payment_webhook_events, payments,
      reports, blocks, messages, conversation_participants, conversation_threads,
      favorites, listing_images, listing_category_details, listings,
      account_deletion_requests, email_verification_tokens, sessions,
      user_profiles, users,
      banned_words, categories, locations
    restart identity cascade
  `);
}
