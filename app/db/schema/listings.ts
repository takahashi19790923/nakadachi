import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import { softDelete, timestamps, ulidPk, ulidRef } from "./_shared.ts";
import {
  handoverMethodEnum,
  itemConditionEnum,
  listingKindEnum,
  listingStatusEnum,
  priceTypeEnum,
  priceUnitEnum,
} from "./enums.ts";
import { categories, locations } from "./taxonomy.ts";
import { users } from "./users.ts";

/**
 * 投稿。
 *
 * ★金額は円単位の整数（integer）で持つ。★ numeric や double にすると
 * 丸めの差が請求額と表示額のずれになる。日本円は最小単位が円そのものなので
 * 整数で過不足なく表せる。
 *
 * ★status を直接 UPDATE しないこと。★ 遷移は app/domain/listing-status.ts の
 * assertTransition を通し、サーバー側のサービス層からのみ行う。
 */
export const listings = pgTable(
  "listings",
  {
    id: ulidPk(),
    ownerId: ulidRef("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    categoryId: ulidRef("category_id")
      .notNull()
      .references(() => categories.id),
    /** 投稿種別。カテゴリごとに意味が違う（売る/買う、工具/家電、アルバイト/正社員…） */
    kind: listingKindEnum("kind").notNull(),

    title: varchar("title", { length: 80 }).notNull(),
    body: text("body").notNull(),

    status: listingStatusEnum("status").notNull().default("draft"),

    /**
     * この投稿を代表する金額（円）。
     * 売買なら価格、貸出なら料金、求人なら給与の下限。カテゴリをまたいで
     * 「価格順」に並べられるように1本化してある。単位は priceUnit を見る。
     */
    priceJpy: integer("price_jpy"),
    priceType: priceTypeEnum("price_type").notNull().default("fixed"),
    priceUnit: priceUnitEnum("price_unit").notNull().default("once"),

    prefectureCode: varchar("prefecture_code", { length: 8 })
      .notNull()
      .references(() => locations.code),
    cityCode: varchar("city_code", { length: 8 })
      .notNull()
      .references(() => locations.code),
    /**
     * 最寄り駅・受け渡し場所の自由入力。
     * ★番地や建物名を書かせない。★ 入力欄の説明と検証で抑止し、
     * 公開する住所の粒度は市区町村までに保つ。
     */
    areaNote: varchar("area_note", { length: 60 }),

    publishedAt: timestamp("published_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),

    /** 管理者が却下・非公開にしたときの理由。本人への通知にも使う */
    moderationReason: text("moderation_reason"),

    viewCount: integer("view_count").notNull().default(0),

    /**
     * キーワード検索用の連結テキスト（生成列）。
     * 日本語は語の区切りが無いため to_tsvector の既定辞書では実用にならない。
     * pg_trgm の GIN 索引 + ILIKE で引く。2文字以下の語では索引が効かない
     * ことを承知の上での MVP の選択（ARCHITECTURE.md「検索の限界」参照）。
     */
    searchText: text("search_text").generatedAlwaysAs(
      sql`(coalesce(title,'') || ' ' || coalesce(body,'') || ' ' || coalesce(area_note,''))`,
    ),

    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    // 一覧・検索の主経路。公開中のものを新しい順に引く。
    index("listings_status_published_at_idx").on(t.status, t.publishedAt.desc()),
    index("listings_status_pref_published_idx").on(
      t.status,
      t.prefectureCode,
      t.publishedAt.desc(),
    ),
    index("listings_status_city_published_idx").on(
      t.status,
      t.cityCode,
      t.publishedAt.desc(),
    ),
    index("listings_status_category_published_idx").on(
      t.status,
      t.categoryId,
      t.publishedAt.desc(),
    ),
    index("listings_status_kind_idx").on(t.status, t.kind),
    // 価格順の並べ替え。
    index("listings_status_price_idx").on(t.status, t.priceJpy),
    // マイページ（自分の投稿）。
    index("listings_owner_status_idx").on(t.ownerId, t.status, t.createdAt.desc()),
    // 期限切れを拾う定期処理。公開中だけを見ればよいので部分索引にする。
    index("listings_expiring_idx")
      .on(t.expiresAt)
      .where(sql`status = 'published'`),
    // キーワード検索。pg_trgm の演算子クラスは生 SQL で指定する。
    index("listings_search_text_trgm_idx")
      .using("gin", sql`${t.searchText} gin_trgm_ops`)
      .where(sql`status = 'published'`),
  ],
);

/**
 * カテゴリ固有の項目。
 *
 * すべてを JSONB へ入れず、★検索条件・並べ替えに使う項目は列にしている★。
 * 逆に、表示するだけの補助情報は extra(JSONB) に入れて、カテゴリを増やす
 * たびにマイグレーションが要る状態を避ける。
 */
export const listingCategoryDetails = pgTable(
  "listing_category_details",
  {
    listingId: ulidRef("listing_id")
      .primaryKey()
      .references(() => listings.id, { onDelete: "cascade" }),

    // ── 売買・譲渡 ────────────────────────────────────────────
    itemCondition: itemConditionEnum("item_condition"),
    handoverMethod: handoverMethodEnum("handover_method"),

    // ── 貸します ──────────────────────────────────────────────
    depositRequired: boolean("deposit_required"),
    /**
     * デポジットの条件文。
     * ★MVP ではサービスが預かり金を扱わない。★ ここは「当事者間でどう扱うか」
     * を説明として表示するだけの欄で、決済も保管も行わない。
     */
    depositNote: varchar("deposit_note", { length: 200 }),
    availableFrom: date("available_from"),
    availableTo: date("available_to"),
    rentalTerms: varchar("rental_terms", { length: 500 }),

    // ── 手伝います・教えます ──────────────────────────────────
    serviceContent: varchar("service_content", { length: 500 }),
    availabilityNote: varchar("availability_note", { length: 200 }),

    // ── お仕事 ────────────────────────────────────────────────
    /** 給与の上限。下限は listings.price_jpy 側に入る */
    salaryMaxJpy: integer("salary_max_jpy"),
    workLocationNote: varchar("work_location_note", { length: 120 }),
    workHours: varchar("work_hours", { length: 200 }),
    qualifications: varchar("qualifications", { length: 500 }),
    benefits: varchar("benefits", { length: 500 }),
    companyName: varchar("company_name", { length: 80 }),

    /** 検索に使わない補助情報だけを入れる。検索条件になるものは列にすること */
    extra: jsonb("extra").$type<Record<string, string>>(),

    ...timestamps(),
  },
  (t) => [
    index("lcd_item_condition_idx").on(t.itemCondition),
    index("lcd_available_idx").on(t.availableFrom, t.availableTo),
  ],
);

/**
 * 投稿写真。
 *
 * R2 のオブジェクトキーだけを持ち、画像そのものは binding 経由でしか触らない。
 * ★投稿を消しても即座に物理削除しない。★ purgeAfter を過ぎたものを定期処理が
 * まとめて消す。誤操作からの復旧余地を残すため。
 */
export const listingImages = pgTable(
  "listing_images",
  {
    id: ulidPk(),
    listingId: ulidRef("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    /** UUID/ULID から作る推測困難なキー。利用者が付けたファイル名は使わない */
    objectKey: varchar("object_key", { length: 160 }).notNull(),
    contentType: varchar("content_type", { length: 40 }).notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    checksumSha256: varchar("checksum_sha256", { length: 64 }).notNull(),
    position: smallint("position").notNull().default(0),
    ...timestamps(),
    ...softDelete(),
    /** この時刻を過ぎたら R2 から実体を消してよい */
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("listing_images_object_key_key").on(t.objectKey),
    index("listing_images_listing_position_idx").on(t.listingId, t.position),
    index("listing_images_purge_idx").on(t.purgeAfter),
  ],
);

export const favorites = pgTable(
  "favorites",
  {
    userId: ulidRef("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    listingId: ulidRef("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("favorites_user_listing_key").on(t.userId, t.listingId),
    index("favorites_user_created_idx").on(t.userId, t.createdAt.desc()),
    index("favorites_listing_idx").on(t.listingId),
  ],
);

export const listingsRelations = relations(listings, ({ one, many }) => ({
  owner: one(users, { fields: [listings.ownerId], references: [users.id] }),
  category: one(categories, {
    fields: [listings.categoryId],
    references: [categories.id],
  }),
  details: one(listingCategoryDetails, {
    fields: [listings.id],
    references: [listingCategoryDetails.listingId],
  }),
  images: many(listingImages),
}));

export const listingImagesRelations = relations(listingImages, ({ one }) => ({
  listing: one(listings, {
    fields: [listingImages.listingId],
    references: [listings.id],
  }),
}));
