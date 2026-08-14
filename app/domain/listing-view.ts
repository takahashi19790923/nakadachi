import {
  CATEGORIES,
  LISTING_KIND_LABEL,
  PRICE_UNIT_LABEL,
  SALARY_UNIT_LABEL,
  type ListingKind,
  type PriceType,
  type PriceUnit,
  type CategorySlug,
} from "./categories";
import { formatJpy } from "./pricing";

/**
 * 一覧カードなどに出す「カテゴリ・種別」の見出し。
 *
 * ★素直に `カテゴリ名・種別名` と繋ぐと読めなくなる。★
 * カテゴリ名自体に「・」が入っているため、
 *   売ります・買います ＋ 売ります → 「売ります・買います・売ります」
 * となり、どこまでがカテゴリ名か分からない。区切りは「／」を使う。
 *
 * また、種別が1つしかないカテゴリでは種別に情報量が無い。
 *   あげます・譲ります ＋ あげます・譲ります → 同じ語の繰り返し
 * この場合はカテゴリ名だけにする。
 */
export function categoryKindLabel(
  categorySlug: CategorySlug,
  kind: ListingKind,
): string {
  const category = CATEGORIES[categorySlug];
  if (category.kinds.length <= 1) return category.name;
  return `${category.shortName}／${LISTING_KIND_LABEL[kind]}`;
}

/**
 * 画面に金額を出すための共通処理。
 *
 * 表示を各画面で組み立てると、「無料なのに 0円 と出る」「求人だけ単位が
 * 抜ける」といったずれが必ず生まれる。1か所に集約する。
 */
export function formatListingPrice(input: {
  categorySlug: CategorySlug;
  priceType: PriceType;
  priceUnit: PriceUnit;
  priceJpy: number | null;
  salaryMaxJpy?: number | null;
}): string {
  if (input.priceType === "free") return "無料";
  if (input.priceType === "negotiable" && input.priceJpy === null) {
    return "相談";
  }
  if (input.priceJpy === null) return "価格未設定";

  if (input.categorySlug === "job") {
    const unit = SALARY_UNIT_LABEL[input.priceUnit] ?? "";
    const range =
      typeof input.salaryMaxJpy === "number" && input.salaryMaxJpy > input.priceJpy
        ? `${formatJpy(input.priceJpy)}〜${formatJpy(input.salaryMaxJpy)}`
        : `${formatJpy(input.priceJpy)}〜`;
    return unit ? `${unit} ${range}` : range;
  }

  const base = formatJpy(input.priceJpy);
  const suffix = input.priceType === "negotiable" ? "（相談可）" : "";
  if (input.priceUnit === "once") return `${base}${suffix}`;
  return `${PRICE_UNIT_LABEL[input.priceUnit]} ${base}${suffix}`;
}

/** 掲載期限までの残り日数。0 なら当日、負なら期限切れ */
export function daysUntil(expiresAt: Date | string | null): number | null {
  if (!expiresAt) return null;
  const target = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  const diffMs = target.getTime() - Date.now();
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

export function formatDateJa(value: Date | string | null): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Tokyo",
  }).format(date);
}

export function formatDateTimeJa(value: Date | string | null): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
  }).format(date);
}
