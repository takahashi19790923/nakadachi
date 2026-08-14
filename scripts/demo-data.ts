import "dotenv/config";
import { eq } from "drizzle-orm";

import {
  listingCategoryDetails,
  listings,
  categories,
  userProfiles,
  users,
} from "../app/db/schema/index.ts";
import { ulid } from "../app/domain/ulid.ts";
import { emailIndexHmac, encryptString } from "../app/server/crypto.server.ts";
import {
  createScriptDb,
  describeError,
  describeTarget,
  parseTarget,
  requireConnectionString,
} from "./db.ts";

/**
 * 見た目を確認するための仮データ。
 *
 *   pnpm run demo:data            → dev
 *   pnpm run demo:data preview    → preview
 *
 * ★本番には入れられない。★ 実在しない出品を本番に置くのは、
 * 利用者から見れば嘘の掲載になる。
 *
 * 何度流しても増えない（同じ ID を使い、既にあれば更新する）。
 */

const DEMO_USERS = [
  { key: "demo-a", email: "demo-a@example.test", name: "たなか" },
  { key: "demo-b", email: "demo-b@example.test", name: "すずき" },
  { key: "demo-c", email: "demo-c@example.test", name: "さとう" },
];

const DEMO_LISTINGS = [
  {
    key: "l1",
    owner: "demo-a",
    category: "sell-buy",
    kind: "sell",
    title: "電動ドリル（makita 14.4V）ほぼ未使用",
    body: "棚を1つ作るために買いましたが、それきり使っていません。バッテリー2本と充電器、ケース付きです。動作確認済み。取りに来ていただける方に。",
    priceJpy: 6500,
    prefectureCode: "13",
    cityCode: "13112",
    areaNote: "世田谷線の駅の近く",
  },
  {
    key: "l2",
    owner: "demo-b",
    category: "giveaway",
    kind: "give",
    title: "子ども用の自転車（16インチ）differ",
    body: "上の子が乗らなくなりました。補助輪は外してありますが、お渡しできます。多少の傷はありますがブレーキ・タイヤは問題ありません。",
    priceJpy: 0,
    prefectureCode: "13",
    cityCode: "13104",
    areaNote: "区役所のあたり",
  },
  {
    key: "l3",
    owner: "demo-c",
    category: "rental",
    kind: "tool",
    title: "脚立（2m）お貸しします",
    body: "年に数回しか使わないので、必要な方にお貸しします。1日単位。ご自宅まで運ぶのは難しいので、取りに来ていただける方限定です。",
    priceJpy: 500,
    priceUnit: "day",
    prefectureCode: "27",
    cityCode: "27100",
    areaNote: "商店街の入口ちかく",
  },
  {
    key: "l4",
    owner: "demo-a",
    category: "help",
    kind: "inperson",
    title: "パソコンの初期設定、お手伝いします",
    body: "Windows の初期設定・メール設定・プリンタの接続まで。ご高齢の方や、久しぶりに買い替えた方向けです。作業は2時間程度をみています。",
    priceJpy: 2000,
    priceUnit: "hour",
    prefectureCode: "13",
    cityCode: "13113",
    areaNote: "ご自宅まで伺います",
  },
  {
    key: "l5",
    owner: "demo-b",
    category: "job",
    kind: "part_time",
    title: "【アルバイト】朝のパン屋の仕込み（週3〜）",
    body: "6時から10時まで。仕込みと焼成の補助です。未経験の方も、いまいる2人が最初はついて教えます。まずは見学だけでも構いません。",
    priceJpy: 1200,
    priceUnit: "hour",
    prefectureCode: "14",
    cityCode: "14130",
    areaNote: "駅から徒歩10分ほど",
  },
  {
    key: "l6",
    owner: "demo-c",
    category: "sell-buy",
    kind: "buy",
    title: "【求む】物置（中古で構いません）",
    body: "庭に置く小さめの物置を探しています。幅1.2m くらいまで。多少さびていても大丈夫です。解体・運搬はこちらで行います。",
    priceJpy: 5000,
    prefectureCode: "27",
    cityCode: "27140",
    areaNote: "取りに伺います",
  },
];

async function main(): Promise<void> {
  const target = parseTarget(process.argv[2]);
  if (target === "production") {
    throw new Error(
      "本番には仮データを入れません。実在しない掲載を出すことになります。",
    );
  }

  const url = requireConnectionString(target);
  const encryptionKey = process.env.EMAIL_ENCRYPTION_KEY;
  const indexKey = process.env.EMAIL_INDEX_KEY;
  if (!encryptionKey || !indexKey) {
    throw new Error("EMAIL_ENCRYPTION_KEY と EMAIL_INDEX_KEY を .env に設定してください。");
  }

  const { db, pool } = createScriptDb(url);
  console.log(`仮データを入れます → ${describeTarget(target)}`);

  try {
    // 利用者
    const userIds = new Map<string, string>();
    for (const demo of DEMO_USERS) {
      const emailHmac = await emailIndexHmac(indexKey, demo.email);
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.emailHmac, emailHmac))
        .limit(1);

      let id = existing[0]?.id;
      if (!id) {
        id = ulid();
        await db.insert(users).values({
          id,
          emailEncrypted: await encryptString(encryptionKey, demo.email),
          emailHmac,
          role: "user",
        });
        await db
          .insert(userProfiles)
          .values({ userId: id, displayName: demo.name })
          .onConflictDoNothing();
      }
      userIds.set(demo.key, id);
    }

    // カテゴリ ID を引く
    const categoryRows = await db
      .select({ id: categories.id, slug: categories.slug })
      .from(categories);
    const categoryIds = new Map(categoryRows.map((row) => [row.slug, row.id]));

    const now = Date.now();
    let count = 0;

    for (const [index, demo] of DEMO_LISTINGS.entries()) {
      const ownerId = userIds.get(demo.owner);
      const categoryId = categoryIds.get(demo.category);
      if (!ownerId || !categoryId) continue;

      // 同じ題名の掲載が既にあれば作り直さない
      const existing = await db
        .select({ id: listings.id })
        .from(listings)
        .where(eq(listings.title, demo.title))
        .limit(1);
      if (existing[0]) continue;

      const id = ulid();
      // 少しずつ時間をずらす。並び順が全部同じだと一覧の見え方が分からない。
      const publishedAt = new Date(now - (index + 1) * 3 * 60 * 60 * 1000);

      await db.insert(listings).values({
        id,
        ownerId,
        categoryId,
        kind: demo.kind as typeof listings.$inferInsert.kind,
        title: demo.title,
        body: demo.body,
        status: "published",
        priceJpy: demo.priceJpy,
        priceType: demo.priceJpy === 0 ? "free" : "fixed",
        priceUnit: (demo.priceUnit ?? "once") as typeof listings.$inferInsert.priceUnit,
        prefectureCode: demo.prefectureCode,
        cityCode: demo.cityCode,
        areaNote: demo.areaNote,
        publishedAt,
        expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
      });
      await db
        .insert(listingCategoryDetails)
        .values({
          listingId: id,
          itemCondition: "good",
          handoverMethod: "pickup",
        })
        .onConflictDoNothing();
      count += 1;
    }

    console.log(`掲載を ${count}件 追加しました（既にあるものは触っていません）。`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("仮データの投入に失敗しました:\n   ", describeError(error));
  process.exitCode = 1;
});
