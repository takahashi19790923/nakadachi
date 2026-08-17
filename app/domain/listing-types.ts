import type {
  CategorySlug,
  ListingKind,
  PriceType,
  PriceUnit,
} from "./categories";
import type { ListingStatus } from "./listing-status";

/**
 * 画面とサーバーの両方が使う投稿の形。
 *
 * ★リポジトリ側（*.server.ts）に置かないこと。★ カード部品などの
 * クライアント側コンポーネントが型を import しただけで、React Router の
 * サーバーコード除去の検査に引っかかり、DB ドライバごとブラウザ側の
 * バンドルへ引き込もうとしてビルドが落ちる。
 * 依存を持たない専用ファイルに切り出しておく。
 */

export interface ListingSummary {
  readonly id: string;
  readonly title: string;
  readonly kind: ListingKind;
  readonly categorySlug: CategorySlug;
  readonly categoryName: string;
  readonly priceJpy: number | null;
  readonly priceType: PriceType;
  readonly priceUnit: PriceUnit;
  readonly salaryMaxJpy: number | null;
  readonly prefectureCode: string;
  readonly prefectureName: string;
  readonly cityCode: string;
  readonly cityName: string;
  readonly areaNote: string | null;
  /** ISO 8601。ローダー境界での型の揺れを避けるため文字列で持つ */
  readonly publishedAt: string | null;
  readonly expiresAt: string | null;
  readonly imageKey: string | null;
}

export interface ListingImageRef {
  readonly id: string;
  readonly objectKey: string;
  readonly width: number;
  readonly height: number;
}

export interface ListingCategoryDetailView {
  readonly itemCondition: string | null;
  readonly handoverMethod: string | null;
  readonly depositRequired: boolean | null;
  readonly depositNote: string | null;
  readonly availableFrom: string | null;
  readonly availableTo: string | null;
  readonly rentalTerms: string | null;
  readonly serviceContent: string | null;
  readonly availabilityNote: string | null;
  readonly salaryMaxJpy: number | null;
  readonly workLocationNote: string | null;
  readonly workHours: string | null;
  readonly qualifications: string | null;
  readonly benefits: string | null;
  readonly companyName: string | null;
}

export interface ListingDetail extends ListingSummary {
  readonly ownerId: string;
  readonly body: string;
  readonly status: ListingStatus;
  /** 掲載期間（日数）。公開時に expiresAt へ換算される */
  readonly durationDays: number;
  readonly viewCount: number;
  readonly createdAt: string;
  readonly moderationReason: string | null;
  readonly images: ListingImageRef[];
  readonly details: ListingCategoryDetailView | null;
}
