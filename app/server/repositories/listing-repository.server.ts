import {
  aliasedTable,
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";

import {
  categories,
  listingCategoryDetails,
  listingImages,
  listings,
  locations,
} from "~/db/schema/index.ts";
import type {
  CategorySlug,
  ListingKind,
  PriceType,
  PriceUnit,
} from "~/domain/categories";
import type { ListingDetail, ListingSummary } from "~/domain/listing-types";
import type { ListingStatus } from "~/domain/listing-status";
import type { Db } from "../db.server.ts";

// 型は依存を持たない専用ファイルにある（クライアント側の部品が import
// できるようにするため）。ここからも再エクスポートしておく。
export type { ListingDetail, ListingSummary } from "~/domain/listing-types";

/**
 * 投稿の読み書き。
 *
 * ★status を直接 UPDATE する関数をここに置かない。★ 遷移は
 * services/listing-service.server.ts が assertTransition を通してから行う。
 * リポジトリを直接叩けば状態を飛ばせる、という抜け道を作らないため。
 */

const prefecture = aliasedTable(locations, "pref");
const city = aliasedTable(locations, "city");

const summaryColumns = {
  id: listings.id,
  title: listings.title,
  kind: listings.kind,
  categorySlug: categories.slug,
  categoryName: categories.name,
  priceJpy: listings.priceJpy,
  priceType: listings.priceType,
  priceUnit: listings.priceUnit,
  salaryMaxJpy: listingCategoryDetails.salaryMaxJpy,
  prefectureCode: listings.prefectureCode,
  prefectureName: prefecture.name,
  cityCode: listings.cityCode,
  cityName: city.name,
  areaNote: listings.areaNote,
  publishedAt: listings.publishedAt,
  expiresAt: listings.expiresAt,
};

type SummaryRow = {
  id: string;
  title: string;
  kind: string;
  categorySlug: string;
  categoryName: string;
  priceJpy: number | null;
  priceType: string;
  priceUnit: string;
  salaryMaxJpy: number | null;
  prefectureCode: string;
  prefectureName: string;
  cityCode: string;
  cityName: string;
  areaNote: string | null;
  publishedAt: Date | null;
  expiresAt: Date | null;
};

/**
 * 一覧の写真は「投稿ごとに先頭の1枚」だけ。
 *
 * 行ごとに問い合わせると件数に比例して往復が増える（ネットワーク越しの DB
 * では 20件で 20往復＝実測で秒単位の差になる）。ID をまとめて1回で引く。
 */
async function attachFirstImages(
  db: Db,
  rows: SummaryRow[],
): Promise<ListingSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const images = await db
    .select({
      listingId: listingImages.listingId,
      objectKey: listingImages.objectKey,
      position: listingImages.position,
    })
    .from(listingImages)
    .where(
      and(inArray(listingImages.listingId, ids), isNull(listingImages.deletedAt)),
    )
    .orderBy(asc(listingImages.listingId), asc(listingImages.position));

  const firstByListing = new Map<string, string>();
  for (const image of images) {
    if (!firstByListing.has(image.listingId)) {
      firstByListing.set(image.listingId, image.objectKey);
    }
  }

  return rows.map((row) => ({
    ...row,
    kind: row.kind as ListingKind,
    categorySlug: row.categorySlug as CategorySlug,
    priceType: row.priceType as PriceType,
    priceUnit: row.priceUnit as PriceUnit,
    // 日付は ISO 文字列に揃える。ローダー境界での型の揺れを無くすため。
    publishedAt: row.publishedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    imageKey: firstByListing.get(row.id) ?? null,
  }));
}

function publishedOnly() {
  // ★公開判定はこの1か所だけ。★ 各画面で status を組み立て直すと、
  // どこか1つで期限切れや非公開が漏れる。
  return and(
    eq(listings.status, "published"),
    isNull(listings.deletedAt),
    sql`(${listings.expiresAt} is null or ${listings.expiresAt} > now())`,
    /*
     * ★投稿者が停止されていたら、その投稿も出さない。★
     *
     * 詐欺の疑いで利用者を止めるのに掲載が出たままでは、止めた意味がない。
     * 本人はログインできないので自分で取り下げることもできず、問い合わせ
     * だけが届き続ける。管理者に「利用者を止める」「投稿を1件ずつ止める」の
     * 二度手間を強いるのも危うい。急いでいるときほど片方を忘れる。
     * （2026-08-17 に発覚。管理画面の経路を実際に通して初めて分かった）
     *
     * 掲載側の status は触らない。復帰させたときに元の状態へそのまま戻る。
     * 掲載を suspended にしてしまうと、どれが利用者停止の巻き添えで、
     * どれが投稿そのものの問題だったのか区別できなくなる。
     *
     * join ではなく exists にしてあるのは、この関数を使う4か所の
     * クエリが users を結合していないため。主キー引きなので安い。
     */
    sql`exists (
      select 1 from users u
      where u.id = ${listings.ownerId}
        and u.status = 'active'
        and u.deleted_at is null
    )`,
  );
}

function summaryQuery(db: Db) {
  return db
    .select(summaryColumns)
    .from(listings)
    .innerJoin(categories, eq(categories.id, listings.categoryId))
    .innerJoin(prefecture, eq(prefecture.code, listings.prefectureCode))
    .innerJoin(city, eq(city.code, listings.cityCode))
    .leftJoin(
      listingCategoryDetails,
      eq(listingCategoryDetails.listingId, listings.id),
    );
}

export async function listRecentPublished(
  db: Db,
  options: { limit: number },
): Promise<ListingSummary[]> {
  const rows = await summaryQuery(db)
    .where(publishedOnly())
    .orderBy(desc(listings.publishedAt))
    .limit(options.limit);
  return attachFirstImages(db, rows);
}

// ── 検索 ──────────────────────────────────────────────────────────

export type ListingSort = "newest" | "price_asc" | "price_desc" | "expiring";

export interface ListingSearchParams {
  categorySlug?: CategorySlug;
  kind?: ListingKind;
  prefectureCode?: string;
  cityCode?: string;
  keyword?: string;
  minPriceJpy?: number;
  maxPriceJpy?: number;
  /**
   * この ID の中だけを引く（お気に入り用）。空配列なら結果は空。
   * ★お気に入りを「新着200件の中から探す」で作っていた頃、201件目以降の
   * 掲載をお気に入りにした人には「掲載終了」と表示された。★ 公開中なのに。
   * SQL で絞る。
   */
  ids?: readonly string[];
  sort: ListingSort;
  page: number;
  perPage: number;
}

export interface ListingSearchResult {
  readonly items: ListingSummary[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly totalPages: number;
}

/**
 * LIKE のメタ文字を打ち消す。
 * これをやらないと、利用者が `%` を1文字入れるだけで全件一致になり、
 * 索引も効かなくなる。
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function buildFilters(params: ListingSearchParams) {
  const conditions = [publishedOnly()];

  if (params.ids) {
    // 空なら何にも一致させない（inArray に空配列を渡すと壊れる）。
    conditions.push(
      params.ids.length > 0 ? inArray(listings.id, [...params.ids]) : sql`false`,
    );
  }
  if (params.categorySlug) {
    conditions.push(eq(categories.slug, params.categorySlug));
  }
  if (params.kind) {
    conditions.push(eq(listings.kind, params.kind));
  }
  if (params.prefectureCode) {
    conditions.push(eq(listings.prefectureCode, params.prefectureCode));
  }
  if (params.cityCode) {
    conditions.push(eq(listings.cityCode, params.cityCode));
  }
  if (typeof params.minPriceJpy === "number") {
    conditions.push(gte(listings.priceJpy, params.minPriceJpy));
  }
  if (typeof params.maxPriceJpy === "number") {
    conditions.push(lte(listings.priceJpy, params.maxPriceJpy));
  }
  if (params.keyword && params.keyword.trim() !== "") {
    const pattern = `%${escapeLike(params.keyword.trim())}%`;
    // 生成列 search_text に対する ILIKE。pg_trgm の GIN 索引が効く。
    conditions.push(sql`${listings.searchText} ilike ${pattern}`);
  }

  return and(...conditions);
}

function buildOrder(sort: ListingSort) {
  switch (sort) {
    case "price_asc":
      // 価格未設定（相談）は最後に回す。null が先頭に来ると一覧が使いにくい。
      return [sql`${listings.priceJpy} asc nulls last`, desc(listings.publishedAt)];
    case "price_desc":
      return [sql`${listings.priceJpy} desc nulls last`, desc(listings.publishedAt)];
    case "expiring":
      return [sql`${listings.expiresAt} asc nulls last`];
    case "newest":
    default:
      return [desc(listings.publishedAt)];
  }
}

export async function searchListings(
  db: Db,
  params: ListingSearchParams,
): Promise<ListingSearchResult> {
  const where = buildFilters(params);
  const offset = (params.page - 1) * params.perPage;

  const [rows, countRows] = await Promise.all([
    summaryQuery(db)
      .where(where)
      .orderBy(...buildOrder(params.sort))
      .limit(params.perPage)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(listings)
      .innerJoin(categories, eq(categories.id, listings.categoryId))
      .where(where),
  ]);

  const total = countRows[0]?.total ?? 0;
  return {
    items: await attachFirstImages(db, rows),
    total,
    page: params.page,
    perPage: params.perPage,
    totalPages: Math.max(1, Math.ceil(total / params.perPage)),
  };
}

// ── 詳細 ──────────────────────────────────────────────────────────

async function loadDetail(
  db: Db,
  listingId: string,
  restrictToPublished: boolean,
): Promise<ListingDetail | null> {
  const conditions: SQL[] = [eq(listings.id, listingId), isNull(listings.deletedAt)];
  if (restrictToPublished) {
    const visible = publishedOnly();
    if (visible) conditions.push(visible);
  }

  /*
   * ★本文と写真は同時に引く。★ 写真の問い合わせは listingId しか使わず、
   * 本文の結果に依存しない。直列にすると DB との往復が1回増える
   * （シンガポールまで片道 100〜250ms）。存在しない ID でも写真側の
   * 問い合わせは走るが、返すのは null のままなので漏れるものは無い。
   */
  const rowsPromise = db
    .select({
      ...summaryColumns,
      ownerId: listings.ownerId,
      body: listings.body,
      status: listings.status,
      durationDays: listings.durationDays,
      viewCount: listings.viewCount,
      createdAt: listings.createdAt,
      moderationReason: listings.moderationReason,
      itemCondition: listingCategoryDetails.itemCondition,
      handoverMethod: listingCategoryDetails.handoverMethod,
      depositRequired: listingCategoryDetails.depositRequired,
      depositNote: listingCategoryDetails.depositNote,
      availableFrom: listingCategoryDetails.availableFrom,
      availableTo: listingCategoryDetails.availableTo,
      rentalTerms: listingCategoryDetails.rentalTerms,
      serviceContent: listingCategoryDetails.serviceContent,
      availabilityNote: listingCategoryDetails.availabilityNote,
      workLocationNote: listingCategoryDetails.workLocationNote,
      workHours: listingCategoryDetails.workHours,
      qualifications: listingCategoryDetails.qualifications,
      benefits: listingCategoryDetails.benefits,
      companyName: listingCategoryDetails.companyName,
    })
    .from(listings)
    .innerJoin(categories, eq(categories.id, listings.categoryId))
    .innerJoin(prefecture, eq(prefecture.code, listings.prefectureCode))
    .innerJoin(city, eq(city.code, listings.cityCode))
    .leftJoin(
      listingCategoryDetails,
      eq(listingCategoryDetails.listingId, listings.id),
    )
    .where(and(...conditions))
    .limit(1);

  const imagesPromise = db
    .select({
      id: listingImages.id,
      objectKey: listingImages.objectKey,
      width: listingImages.width,
      height: listingImages.height,
    })
    .from(listingImages)
    .where(
      and(
        eq(listingImages.listingId, listingId),
        isNull(listingImages.deletedAt),
      ),
    )
    .orderBy(asc(listingImages.position));

  const [rows, images] = await Promise.all([rowsPromise, imagesPromise]);
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    categorySlug: row.categorySlug as CategorySlug,
    categoryName: row.categoryName,
    priceJpy: row.priceJpy,
    priceType: row.priceType,
    priceUnit: row.priceUnit,
    salaryMaxJpy: row.salaryMaxJpy,
    prefectureCode: row.prefectureCode,
    prefectureName: row.prefectureName,
    cityCode: row.cityCode,
    cityName: row.cityName,
    areaNote: row.areaNote,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    imageKey: images[0]?.objectKey ?? null,
    ownerId: row.ownerId,
    body: row.body,
    status: row.status,
    durationDays: row.durationDays,
    viewCount: row.viewCount,
    createdAt: row.createdAt.toISOString(),
    moderationReason: row.moderationReason,
    images,
    details: {
      itemCondition: row.itemCondition,
      handoverMethod: row.handoverMethod,
      depositRequired: row.depositRequired,
      depositNote: row.depositNote,
      availableFrom: row.availableFrom,
      availableTo: row.availableTo,
      rentalTerms: row.rentalTerms,
      serviceContent: row.serviceContent,
      availabilityNote: row.availabilityNote,
      salaryMaxJpy: row.salaryMaxJpy,
      workLocationNote: row.workLocationNote,
      workHours: row.workHours,
      qualifications: row.qualifications,
      benefits: row.benefits,
      companyName: row.companyName,
    },
  };
}

/** 公開ページ用。公開中でなければ null（存在すら知らせない） */
export function getPublishedListing(
  db: Db,
  listingId: string,
): Promise<ListingDetail | null> {
  return loadDetail(db, listingId, true);
}

/** 本人・管理者用。状態に関わらず引く。呼び出し側で必ず権限を確かめること */
export function getListingForOwner(
  db: Db,
  listingId: string,
): Promise<ListingDetail | null> {
  return loadDetail(db, listingId, false);
}

/** 所有者の確認だけを軽く行う（本文を読み込まない） */
export async function getListingOwnership(
  db: Db,
  listingId: string,
): Promise<{ ownerId: string; status: ListingStatus } | null> {
  const rows = await db
    .select({ ownerId: listings.ownerId, status: listings.status })
    .from(listings)
    .where(and(eq(listings.id, listingId), isNull(listings.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listByOwner(
  db: Db,
  ownerId: string,
  statuses: ListingStatus[],
): Promise<ListingSummary[]> {
  const rows = await summaryQuery(db)
    .where(
      and(
        eq(listings.ownerId, ownerId),
        inArray(listings.status, statuses),
        isNull(listings.deletedAt),
      ),
    )
    .orderBy(desc(listings.createdAt));
  return attachFirstImages(db, rows);
}

/**
 * 閲覧数を1つ増やす。
 * 応答を待たせないよう waitUntil から呼ぶ。失敗しても画面は壊さない。
 */
export async function incrementViewCount(
  db: Db,
  listingId: string,
): Promise<void> {
  await db
    .update(listings)
    .set({ viewCount: sql`${listings.viewCount} + 1` })
    .where(eq(listings.id, listingId));
}

/** sitemap 用。公開中のものだけを、件数を絞って返す */
export async function listPublishedForSitemap(
  db: Db,
  limit = 5000,
): Promise<{ id: string; updatedAt: string }[]> {
  const rows = await db
    .select({ id: listings.id, updatedAt: listings.updatedAt })
    .from(listings)
    .where(publishedOnly())
    .orderBy(desc(listings.publishedAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    updatedAt: row.updatedAt.toISOString(),
  }));
}
