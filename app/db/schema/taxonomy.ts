import {
  boolean,
  index,
  integer,
  pgTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import { timestamps, ulidPk } from "./_shared.ts";
import { locationKindEnum } from "./enums.ts";

/**
 * カテゴリ。
 *
 * 実体の定義（選択肢・表示順・フォーム項目）は app/domain/categories.ts にあり、
 * この表は「投稿から参照するための行」と、将来の表示名変更・並べ替えのため
 * だけに持つ。seed が domain 側の定義から行を作るので、両者はずれない。
 */
export const categories = pgTable(
  "categories",
  {
    id: ulidPk(),
    slug: varchar("slug", { length: 32 }).notNull(),
    name: varchar("name", { length: 60 }).notNull(),
    description: varchar("description", { length: 200 }),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("categories_slug_key").on(t.slug),
    index("categories_sort_order_idx").on(t.sortOrder),
  ],
);

/**
 * 地域マスタ（都道府県・市区町村）。
 *
 * 1つの表に kind で持たせている。市区町村は parentCode で都道府県を指す。
 * 市町村合併で名前や区分が変わるため、★行を消さずに isActive を落とす★。
 * 消すと、その地域で過去に出された投稿の外部キーが壊れる。
 *
 * code は総務省の全国地方公共団体コード（都道府県2桁 / 市区町村5桁）。
 * 投稿からは code で参照する。ID より読みやすく、URL にも出せる。
 */
export const locations = pgTable(
  "locations",
  {
    id: ulidPk(),
    /**
     * ★索引ではなく UNIQUE 制約にする。★
     * listings がこの列を外部キーで参照する。マイグレーションは
     * 「テーブル作成 → 外部キー → 索引」の順に流れるため、索引だけだと
     * 外部キーを張る時点でまだ存在せず
     * 「there is no unique constraint matching given keys」で落ちる。
     * 制約なら CREATE TABLE と同時に作られるので順序の問題が起きない。
     */
    code: varchar("code", { length: 8 }).notNull().unique("locations_code_key"),
    kind: locationKindEnum("kind").notNull(),
    /** 市区町村なら所属する都道府県の code。都道府県なら null */
    parentCode: varchar("parent_code", { length: 8 }),
    name: varchar("name", { length: 40 }).notNull(),
    kana: varchar("kana", { length: 60 }),
    /** URL に使う英字表記（都道府県のみ）。例: tokyo */
    romaji: varchar("romaji", { length: 40 }),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    index("locations_kind_parent_idx").on(t.kind, t.parentCode, t.sortOrder),
    index("locations_romaji_idx").on(t.romaji),
  ],
);
