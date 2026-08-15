import { asc } from "drizzle-orm";

import { locations } from "~/db/schema/index.ts";
import type { Db } from "../db.server.ts";

export interface LocationRow {
  readonly code: string;
  readonly name: string;
  readonly kana: string | null;
  readonly romaji: string | null;
}

interface IndexedLocation extends LocationRow {
  readonly kind: "prefecture" | "city";
  readonly parentCode: string | null;
  readonly isActive: boolean;
}

interface LocationIndex {
  /** 並び順を保った全件。表示は使う側で isActive を見て絞る */
  readonly all: readonly IndexedLocation[];
  readonly byCode: ReadonlyMap<string, IndexedLocation>;
}

/*
 * ★都道府県・市区町村は実行中に変わらない参照データなので、
 *   Worker のアイソレート内に持っておく。★
 *
 * 変わるのは seed を流し直したときだけで、それはデプロイと同時に起きる
 * （デプロイでアイソレートは作り直される）。
 *
 * これが効くのは往復の回数がそのまま待ち時間になるため。このサービスの
 * DB はシンガポールにあり、1往復あたり 100〜250ms かかる（2026-08-16 実測）。
 * 地域ページ・投稿フォーム・sitemap は、どれも地域データを引いてから
 * 次の問い合わせに進むので、ここを消すと画面がまるごと1往復ぶん速くなる。
 *
 * ★保険として期限を切ってある。★ 何かの拍子に seed だけ流し直した場合でも、
 * この時間で追いつく。無期限にすると、原因の分からない「古い地域が出る」を
 * 作りかねない。
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

let cached: { index: LocationIndex; loadedAt: number } | null = null;
let inFlight: Promise<LocationIndex> | null = null;

/**
 * キャッシュを捨てる。
 *
 * ★テストから必ず呼ぶこと。★ 統合テストは1件ごとに TRUNCATE して
 * seed をやり直すので、持ち越すと前のテストの地域を見てしまう。
 * 本番でこれを呼ぶ場面は無い。
 */
export function clearLocationCache(): void {
  cached = null;
  inFlight = null;
}

async function loadIndex(db: Db): Promise<LocationIndex> {
  const rows = await db
    .select({
      code: locations.code,
      name: locations.name,
      kana: locations.kana,
      romaji: locations.romaji,
      kind: locations.kind,
      parentCode: locations.parentCode,
      isActive: locations.isActive,
    })
    .from(locations)
    .orderBy(asc(locations.sortOrder));

  const all = rows as unknown as IndexedLocation[];
  return {
    all,
    byCode: new Map(all.map((row) => [row.code, row])),
  };
}

async function getIndex(db: Db): Promise<LocationIndex> {
  const now = Date.now();
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) return cached.index;

  // ★同時に来た分は1回の問い合わせに相乗りさせる。★
  // 冷えた直後にアクセスが重なると、同じ問い合わせが何本も飛ぶ。
  inFlight ??= loadIndex(db)
    .then((index) => {
      cached = { index, loadedAt: Date.now() };
      return index;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

function toRow(row: IndexedLocation): LocationRow {
  return { code: row.code, name: row.name, kana: row.kana, romaji: row.romaji };
}

/**
 * 都道府県の一覧。
 * 使われなくなった行は削除せず isActive を落とすので、表示は必ず絞る
 * （過去の投稿が参照している行を消すと外部キーが壊れる）。
 */
export async function listPrefectures(db: Db): Promise<LocationRow[]> {
  const index = await getIndex(db);
  return index.all
    .filter((row) => row.kind === "prefecture" && row.isActive)
    .map(toRow);
}

export async function listCities(
  db: Db,
  prefectureCode: string,
): Promise<LocationRow[]> {
  const index = await getIndex(db);
  return index.all
    .filter(
      (row) =>
        row.kind === "city" &&
        row.isActive &&
        row.parentCode === prefectureCode,
    )
    .map(toRow);
}

/**
 * 全市区町村。投稿フォームの地域選択（optgroup で束ねる）に使う。
 * 都道府県ごとの絞り込みを段階的に行わないので、1回で全部渡す。
 */
export async function listAllCities(
  db: Db,
): Promise<{ code: string; name: string; parentCode: string }[]> {
  const index = await getIndex(db);
  return index.all
    .filter((row) => row.kind === "city" && row.isActive)
    .map((row) => ({
      code: row.code,
      name: row.name,
      parentCode: row.parentCode ?? "",
    }));
}

export async function getLocation(
  db: Db,
  code: string,
): Promise<(LocationRow & { kind: "prefecture" | "city"; parentCode: string | null }) | null> {
  const index = await getIndex(db);
  const row = index.byCode.get(code);
  if (!row) return null;
  // ★isActive では絞らない。★ 過去の投稿が参照している地域も引けないと、
  // その投稿の画面が開けなくなる。
  return {
    ...toRow(row),
    kind: row.kind,
    parentCode: row.parentCode,
  };
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
  const index = await getIndex(db);
  const city = index.byCode.get(cityCode);
  return (
    city !== undefined &&
    city.kind === "city" &&
    city.isActive &&
    city.parentCode === prefectureCode
  );
}
