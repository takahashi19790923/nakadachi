import { and, asc, eq } from "drizzle-orm";

import { locations } from "~/db/schema/index.ts";
import type { Db } from "../db.server.ts";

export interface LocationRow {
  readonly code: string;
  readonly name: string;
  readonly kana: string | null;
  readonly romaji: string | null;
}

/**
 * 都道府県の一覧。
 * 使われなくなった行は削除せず isActive を落とすので、表示は必ず絞る
 * （過去の投稿が参照している行を消すと外部キーが壊れる）。
 */
export async function listPrefectures(db: Db): Promise<LocationRow[]> {
  return db
    .select({
      code: locations.code,
      name: locations.name,
      kana: locations.kana,
      romaji: locations.romaji,
    })
    .from(locations)
    .where(and(eq(locations.kind, "prefecture"), eq(locations.isActive, true)))
    .orderBy(asc(locations.sortOrder));
}

export async function listCities(
  db: Db,
  prefectureCode: string,
): Promise<LocationRow[]> {
  return db
    .select({
      code: locations.code,
      name: locations.name,
      kana: locations.kana,
      romaji: locations.romaji,
    })
    .from(locations)
    .where(
      and(
        eq(locations.kind, "city"),
        eq(locations.parentCode, prefectureCode),
        eq(locations.isActive, true),
      ),
    )
    .orderBy(asc(locations.sortOrder));
}

/**
 * 全市区町村。投稿フォームの地域選択（optgroup で束ねる）に使う。
 * 都道府県ごとの絞り込みを段階的に行わないので、1回で全部渡す。
 * seed の規模（主要自治体）なら数百行なので、1回の問い合わせで足りる。
 */
export async function listAllCities(
  db: Db,
): Promise<{ code: string; name: string; parentCode: string }[]> {
  const rows = await db
    .select({
      code: locations.code,
      name: locations.name,
      parentCode: locations.parentCode,
    })
    .from(locations)
    .where(and(eq(locations.kind, "city"), eq(locations.isActive, true)))
    .orderBy(asc(locations.sortOrder));

  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    parentCode: row.parentCode ?? "",
  }));
}

export async function getLocation(
  db: Db,
  code: string,
): Promise<(LocationRow & { kind: "prefecture" | "city"; parentCode: string | null }) | null> {
  const rows = await db
    .select({
      code: locations.code,
      name: locations.name,
      kana: locations.kana,
      romaji: locations.romaji,
      kind: locations.kind,
      parentCode: locations.parentCode,
    })
    .from(locations)
    .where(eq(locations.code, code))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 入力された都道府県・市区町村の組み合わせが実在するかを確かめる。
 * ★フォームの選択肢を信用しない。★ 送信内容は書き換えられる。
 */
export async function isValidAreaPair(
  db: Db,
  prefectureCode: string,
  cityCode: string,
): Promise<boolean> {
  const rows = await db
    .select({ code: locations.code })
    .from(locations)
    .where(
      and(
        eq(locations.code, cityCode),
        eq(locations.kind, "city"),
        eq(locations.parentCode, prefectureCode),
        eq(locations.isActive, true),
      ),
    )
    .limit(1);
  return rows.length === 1;
}
