import { and, eq, isNull, lte, sql } from "drizzle-orm";

import {
  categories,
  listingCategoryDetails,
  listings,
} from "~/db/schema/index.ts";
import { CATEGORIES } from "~/domain/categories";
import {
  assertTransition,
  type ListingStatus,
  type TransitionActor,
} from "~/domain/listing-status";
import { LISTING_DURATION_DAYS_DEFAULT } from "~/domain/pricing";
import { ulid } from "~/domain/ulid.ts";
import type { ListingInput } from "~/domain/validation/listing";
import type { Db } from "../db.server.ts";
import { AppError, notFound } from "../errors.ts";
import { isValidAreaPair } from "../repositories/location-repository.server.ts";
import { findBlockingWord } from "../repositories/moderation-repository.server.ts";

/**
 * 投稿のサービス層。
 *
 * ★状態の変更はここだけを通す。★ ルートやリポジトリから status を直接
 * 書き換えないこと。遷移の可否は必ず assertTransition が判断する。
 */

export interface SaveDraftResult {
  listingId: string;
}

async function resolveCategoryId(
  db: Db,
  slug: string,
): Promise<string> {
  const rows = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.slug, slug), eq(categories.isActive, true)))
    .limit(1);
  const id = rows[0]?.id;
  if (!id) {
    throw new AppError("validation_failed", "カテゴリの指定が不正です", {
      detail: `unknown category slug: ${slug}`,
    });
  }
  return id;
}

/** 入力から、テーブルに入れる形へ落とす */
function toDetailValues(input: ListingInput) {
  switch (input.categorySlug) {
    case "sell-buy":
    case "giveaway":
      return {
        itemCondition: input.itemCondition,
        handoverMethod: input.handoverMethod,
      };
    case "rental":
      return {
        itemCondition: input.itemCondition,
        depositRequired: input.depositRequired,
        depositNote: input.depositNote ?? null,
        availableFrom: input.availableFrom ?? null,
        availableTo: input.availableTo ?? null,
        rentalTerms: input.rentalTerms ?? null,
      };
    case "help":
      return {
        serviceContent: input.serviceContent,
        availabilityNote: input.availabilityNote ?? null,
      };
    case "job":
      return {
        salaryMaxJpy: input.salaryMaxJpy,
        workLocationNote: input.workLocationNote ?? null,
        workHours: input.workHours,
        qualifications: input.qualifications ?? null,
        benefits: input.benefits ?? null,
        companyName: input.companyName,
      };
  }
}

/**
 * 入力の共通検証。
 * 地域の組み合わせと禁止ワードは DB を引く必要があるので、Zod ではなくここで見る。
 */
async function validateAgainstDatabase(
  db: Db,
  input: ListingInput,
): Promise<void> {
  // ★フォームの選択肢を信用しない。★ 送信内容は書き換えられる。
  const areaOk = await isValidAreaPair(db, input.prefectureCode, input.cityCode);
  if (!areaOk) {
    throw new AppError("validation_failed", "地域の指定をご確認ください", {
      fields: { cityCode: "都道府県と市区町村の組み合わせが正しくありません" },
    });
  }

  const blocked = await findBlockingWord(db, `${input.title}\n${input.body}`);
  if (blocked) {
    throw new AppError(
      "validation_failed",
      "掲載できない内容が含まれています。禁止行為・禁止出品物のページをご確認ください。",
      { fields: { body: "掲載できない語句が含まれています" } },
    );
  }
}

export async function createDraft(
  db: Db,
  ownerId: string,
  input: ListingInput,
): Promise<SaveDraftResult> {
  await validateAgainstDatabase(db, input);
  const categoryId = await resolveCategoryId(db, input.categorySlug);
  const listingId = ulid();

  // 下書きと詳細は必ず揃って存在させる。片方だけ残ると画面が壊れる。
  await db.transaction(async (tx) => {
    await tx.insert(listings).values({
      id: listingId,
      ownerId,
      categoryId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      status: "draft",
      priceJpy: input.priceJpy,
      priceType: input.priceType,
      priceUnit: input.priceUnit ?? "once",
      prefectureCode: input.prefectureCode,
      cityCode: input.cityCode,
      areaNote: input.areaNote ?? null,
      // 掲載期間は日数で保存し、公開時に expires_at へ換算する。
      durationDays: input.durationDays ?? LISTING_DURATION_DAYS_DEFAULT,
      expiresAt: null,
    });
    await tx.insert(listingCategoryDetails).values({
      listingId,
      ...toDetailValues(input),
    });
  });

  return { listingId };
}

/**
 * 下書き・公開済みの編集。
 *
 * ★公開済みの通常編集では再課金しない。★ 状態は published のまま。
 * カテゴリの変更は許さない（課金済みの投稿が別カテゴリへ移ると、
 * 掲載枠の意味が変わってしまう）。
 */
export async function updateListing(
  db: Db,
  listingId: string,
  input: ListingInput,
): Promise<void> {
  await validateAgainstDatabase(db, input);

  const current = await db
    .select({
      status: listings.status,
      categoryId: listings.categoryId,
      slug: categories.slug,
    })
    .from(listings)
    .innerJoin(categories, eq(categories.id, listings.categoryId))
    .where(and(eq(listings.id, listingId), isNull(listings.deletedAt)))
    .limit(1);

  const row = current[0];
  if (!row) throw notFound(`listing not found: ${listingId}`);

  if (row.slug !== input.categorySlug) {
    throw new AppError(
      "validation_failed",
      "カテゴリは後から変更できません。新しい投稿として作成してください。",
      { detail: `category change attempted: ${row.slug} -> ${input.categorySlug}` },
    );
  }

  // 編集できる状態を限定する。決済中の投稿を書き換えられると、
  // 課金した内容と公開される内容が食い違う。
  const editable: ListingStatus[] = ["draft", "published"];
  if (!editable.includes(row.status)) {
    throw new AppError(
      "conflict",
      "この状態の投稿は編集できません。",
      { detail: `edit attempted on status=${row.status}` },
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(listings)
      .set({
        kind: input.kind,
        title: input.title,
        body: input.body,
        priceJpy: input.priceJpy,
        priceType: input.priceType,
        priceUnit: input.priceUnit ?? "once",
        prefectureCode: input.prefectureCode,
        cityCode: input.cityCode,
        areaNote: input.areaNote ?? null,
        /*
         * 掲載期間は下書きのあいだだけ変えられる。公開後は編集画面に
         * 欄が無く送られてこない（undefined）。★公開中に変えられると
         * expires_at と食い違い、期限が来ても終わらない・早く終わる★
         * ができる。送られてきても公開中なら無視する。
         */
        ...(row.status === "draft" && input.durationDays !== undefined
          ? { durationDays: input.durationDays }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(listings.id, listingId));

    await tx
      .update(listingCategoryDetails)
      .set({ ...toDetailValues(input), updatedAt: new Date() })
      .where(eq(listingCategoryDetails.listingId, listingId));
  });
}

/**
 * 状態遷移。★これ以外の経路で status を変えないこと。★
 *
 * expectedFrom を渡すと、その状態からの遷移だけを許す。決済の確定処理で
 * 「二重に published にしない」ために使う（WHERE 句に含めるので、
 * 同時に2つ来ても片方しか成立しない）。
 */
export async function transitionListing(
  db: Db,
  options: {
    listingId: string;
    to: ListingStatus;
    actor: TransitionActor;
    expectedFrom?: ListingStatus;
    moderationReason?: string;
    durationDays?: number;
    /** トランザクション内から呼ぶとき */
    tx?: Db;
  },
): Promise<{ changed: boolean; from: ListingStatus }> {
  const executor = options.tx ?? db;

  const rows = await executor
    .select({
      status: listings.status,
      durationDays: listings.durationDays,
      publishedAt: listings.publishedAt,
    })
    .from(listings)
    .where(eq(listings.id, options.listingId))
    .limit(1);

  const current = rows[0];
  const from = current?.status;
  if (!current || !from) throw notFound(`listing not found: ${options.listingId}`);

  if (options.expectedFrom && from !== options.expectedFrom) {
    return { changed: false, from };
  }

  assertTransition(from, options.to, options.actor);

  const now = new Date();
  const values: Record<string, unknown> = {
    status: options.to,
    updatedAt: now,
  };

  if (options.to === "published") {
    values.moderationReason = null;
    if (from === "suspended" && current.publishedAt) {
      /*
       * ★非公開からの復帰では期間を作り直さない。★ 管理者が一時的に
       * 止めて戻しただけで、published_at が今日になり expires_at が
       * また30日先になっていた（払っていない期間が増える）。
       * 元の日付をそのまま残す。期限がすでに過ぎていれば、毎時の
       * 期限切れ処理が expired にする。それが正しい。
       */
    } else {
      values.publishedAt = now;
      /*
       * ★日数は行の duration_days が正。★ 呼び出し側の値は、それより
       * 優先させたい特別な理由があるときだけ渡す（今のところ無い）。
       * 以前は Checkout の metadata から読んだ値をそのまま使っていて、
       * 確認画面のフォームを書き換えれば任意の日数で公開できた。
       */
      const days = options.durationDays ?? current.durationDays;
      values.expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    }
  }
  if (options.to === "closed" || options.to === "expired") {
    values.closedAt = now;
  }
  if (options.to === "suspended" || options.to === "rejected") {
    values.moderationReason = options.moderationReason ?? null;
  }
  if (options.to === "deleted") {
    values.deletedAt = now;
  }

  const conditions = [eq(listings.id, options.listingId)];
  if (options.expectedFrom) {
    // 競合しても1回しか成立しないよう、状態を WHERE に入れる。
    conditions.push(eq(listings.status, options.expectedFrom));
  }

  const result = await executor
    .update(listings)
    .set(values)
    .where(and(...conditions));

  return { changed: (result.rowCount ?? 0) > 0, from };
}

/**
 * 期限切れの取り込み。定期処理から呼ぶ。
 * 1回で処理する件数を区切り、長時間の実行でリクエストが切れないようにする。
 */
export async function expireDueListings(
  db: Db,
  limit = 200,
): Promise<string[]> {
  const due = await db
    .select({ id: listings.id })
    .from(listings)
    .where(
      and(
        eq(listings.status, "published"),
        isNull(listings.deletedAt),
        lte(listings.expiresAt, new Date()),
      ),
    )
    .limit(limit);

  const changed: string[] = [];
  for (const row of due) {
    const result = await transitionListing(db, {
      listingId: row.id,
      to: "expired",
      actor: "system",
      expectedFrom: "published",
    });
    if (result.changed) changed.push(row.id);
  }
  return changed;
}

/** 投稿数の集計。管理画面のダッシュボードに使う */
export async function countListingsByStatus(
  db: Db,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: listings.status, count: sql<number>`count(*)::int` })
    .from(listings)
    .where(isNull(listings.deletedAt))
    .groupBy(listings.status);

  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = row.count;
  return out;
}

/** そのカテゴリの定義。画面が選択肢を出すために使う */
export function categoryDefinition(slug: keyof typeof CATEGORIES) {
  return CATEGORIES[slug];
}
