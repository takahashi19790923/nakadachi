/**
 * カテゴリと、カテゴリ固有の選択肢の定義。
 *
 * 画面のフォーム・Zod スキーマ・DB の CHECK 制約が、いずれもこの定義から
 * 導かれるようにしてある。3か所に同じ選択肢を書くと、必ずどれかがずれる。
 *
 * 依存を持たない純粋なデータなので、クライアントからも import してよい。
 */

export const CATEGORY_SLUGS = [
  "sell-buy",
  "giveaway",
  "rental",
  "help",
  "job",
] as const;
export type CategorySlug = (typeof CATEGORY_SLUGS)[number];

export function isCategorySlug(value: unknown): value is CategorySlug {
  return (
    typeof value === "string" &&
    (CATEGORY_SLUGS as readonly string[]).includes(value)
  );
}

// ── 共通の選択肢 ──────────────────────────────────────────────────

/**
 * 価格の種別。
 * 「無料」を価格 0 円と区別して持つ理由は、0 円の固定価格（送料のみ等）と
 * 「もらってください」を検索で分けたいため。
 */
export const PRICE_TYPES = ["fixed", "negotiable", "free"] as const;
export type PriceType = (typeof PRICE_TYPES)[number];
export const PRICE_TYPE_LABEL: Readonly<Record<PriceType, string>> = {
  fixed: "固定価格",
  negotiable: "相談",
  free: "無料",
};

/**
 * 金額の単位。
 * 貸出料金の単位（時間・日・週・月・その他）と、求人の給与単位（時給・日給・
 * 月給・年収）を1つの列にまとめている。列を分けると「価格順に並べる」処理が
 * カテゴリごとに分岐して壊れやすくなるため。
 */
export const PRICE_UNITS = [
  "once",
  "hour",
  "day",
  "week",
  "month",
  "year",
  "other",
] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];
export const PRICE_UNIT_LABEL: Readonly<Record<PriceUnit, string>> = {
  once: "一括",
  hour: "1時間あたり",
  day: "1日あたり",
  week: "1週間あたり",
  month: "1か月あたり",
  year: "1年あたり",
  other: "その他",
};
/** 求人の給与単位として画面に出すときの言い換え */
export const SALARY_UNIT_LABEL: Readonly<Partial<Record<PriceUnit, string>>> = {
  hour: "時給",
  day: "日給",
  month: "月給",
  year: "年収",
};
export const SALARY_UNITS = ["hour", "day", "month", "year"] as const;

/** 品物の状態 */
export const ITEM_CONDITIONS = [
  "new",
  "like_new",
  "good",
  "fair",
  "poor",
  "for_parts",
] as const;
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];
export const ITEM_CONDITION_LABEL: Readonly<Record<ItemCondition, string>> = {
  new: "新品・未使用",
  like_new: "未使用に近い",
  good: "目立った傷や汚れなし",
  fair: "やや傷や汚れあり",
  poor: "傷や汚れあり",
  for_parts: "ジャンク・部品取り",
};

/** 受け渡し方法 */
export const HANDOVER_METHODS = ["pickup", "shipping", "either"] as const;
export type HandoverMethod = (typeof HANDOVER_METHODS)[number];
export const HANDOVER_METHOD_LABEL: Readonly<Record<HandoverMethod, string>> = {
  pickup: "直接手渡し",
  shipping: "配送",
  either: "どちらでも可",
};

// ── 投稿種別（kind）──────────────────────────────────────────────
// カテゴリごとに意味が違う。検索の「投稿種別」フィルタはこの列を見る。

export const SELL_BUY_KINDS = ["sell", "buy"] as const;
export const GIVEAWAY_KINDS = ["give"] as const;
export const RENTAL_KINDS = [
  "realestate",
  "tool",
  "appliance",
  "outdoor",
  "vehicle",
  "other",
] as const;
export const HELP_KINDS = ["online", "inperson", "both"] as const;
/**
 * 雇用形態。MVP の画面に出すのはアルバイトと正社員の2つだけだが、
 * 将来 契約社員・業務委託 を足せるよう列は文字列で持つ。
 */
export const JOB_KINDS = ["part_time", "full_time"] as const;

export const LISTING_KINDS = [
  ...SELL_BUY_KINDS,
  ...GIVEAWAY_KINDS,
  ...RENTAL_KINDS,
  ...HELP_KINDS,
  ...JOB_KINDS,
] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];

export const LISTING_KIND_LABEL: Readonly<Record<ListingKind, string>> = {
  sell: "売ります",
  buy: "買います",
  give: "あげます・譲ります",
  realestate: "不動産",
  tool: "工具",
  appliance: "家電",
  outdoor: "アウトドア用品",
  vehicle: "車両・自転車",
  other: "その他の日常品",
  online: "オンライン",
  inperson: "対面",
  both: "オンライン・対面どちらも",
  part_time: "アルバイト",
  full_time: "正社員",
};

// ── カテゴリ定義 ──────────────────────────────────────────────────

export interface CategoryDefinition {
  readonly slug: CategorySlug;
  readonly name: string;
  readonly shortName: string;
  readonly description: string;
  /** 検索の「投稿種別」に使う選択肢 */
  readonly kinds: readonly ListingKind[];
  /** 「投稿種別」欄の見出し。カテゴリごとに意味が違うので文言を変える */
  readonly kindLabel: string;
  /** そのカテゴリで使う価格種別。空なら価格欄自体を出さない */
  readonly priceTypes: readonly PriceType[];
  /** 価格の単位として選ばせる値。1つだけなら固定で使い、欄を出さない */
  readonly priceUnits: readonly PriceUnit[];
  readonly priceLabel: string;
  /** 品物の状態を訊くか */
  readonly usesItemCondition: boolean;
  /** 受け渡し方法を訊くか */
  readonly usesHandover: boolean;
  /** 一覧・詳細で強調する項目の並び（表示順の意図をここに集約する） */
  readonly highlightFields: readonly string[];
}

export const CATEGORIES: Readonly<Record<CategorySlug, CategoryDefinition>> = {
  "sell-buy": {
    slug: "sell-buy",
    name: "売ります・買います",
    shortName: "売買",
    description: "使わなくなったものを売る、探しているものを買う。",
    kinds: SELL_BUY_KINDS,
    kindLabel: "投稿種別",
    priceTypes: PRICE_TYPES,
    priceUnits: ["once"],
    priceLabel: "価格",
    usesItemCondition: true,
    usesHandover: true,
    highlightFields: ["price", "itemCondition", "handoverMethod"],
  },
  giveaway: {
    slug: "giveaway",
    name: "あげます・譲ります",
    shortName: "譲ります",
    description: "無料または少額で、必要な人へ譲る。",
    kinds: GIVEAWAY_KINDS,
    kindLabel: "投稿種別",
    // 「無料／有料」を価格種別で表す。相談は使わない。
    priceTypes: ["free", "fixed"],
    priceUnits: ["once"],
    priceLabel: "譲渡価格",
    usesItemCondition: true,
    usesHandover: true,
    highlightFields: ["price", "itemCondition", "handoverMethod"],
  },
  rental: {
    slug: "rental",
    name: "貸します",
    shortName: "貸します",
    description:
      "不動産だけでなく、電動ドライバー・脚立・アウトドア用品など、たまにしか使わない日常品も。",
    kinds: RENTAL_KINDS,
    kindLabel: "対象種別",
    priceTypes: ["fixed", "negotiable", "free"],
    priceUnits: ["hour", "day", "week", "month", "other"],
    priceLabel: "貸出料金",
    usesItemCondition: true,
    usesHandover: false,
    highlightFields: ["price", "rentalPeriod", "deposit", "itemCondition"],
  },
  help: {
    slug: "help",
    name: "手伝います・教えます",
    shortName: "手伝います",
    description: "得意なことで手を貸す、教える。",
    kinds: HELP_KINDS,
    kindLabel: "対応方法",
    priceTypes: ["fixed", "negotiable", "free"],
    priceUnits: ["once", "hour", "day", "other"],
    priceLabel: "料金",
    usesItemCondition: false,
    usesHandover: false,
    highlightFields: ["price", "availability", "serviceMode"],
  },
  job: {
    slug: "job",
    name: "お仕事",
    shortName: "仕事",
    description: "地域の求人。アルバイトと正社員。",
    kinds: JOB_KINDS,
    kindLabel: "雇用形態",
    // 求人は「相談」「無料」を使わない。給与は必ず金額で示す。
    priceTypes: ["fixed"],
    priceUnits: SALARY_UNITS,
    priceLabel: "給与",
    usesItemCondition: false,
    usesHandover: false,
    highlightFields: ["salary", "employmentType", "workHours", "companyName"],
  },
};

export const CATEGORY_LIST: readonly CategoryDefinition[] =
  CATEGORY_SLUGS.map((slug) => CATEGORIES[slug]);

/** その kind がそのカテゴリで使えるか。サーバー側の検証で必ず通す */
export function isKindOfCategory(
  slug: CategorySlug,
  kind: unknown,
): kind is ListingKind {
  return (
    typeof kind === "string" &&
    (CATEGORIES[slug].kinds as readonly string[]).includes(kind)
  );
}

/** kind からカテゴリを引く。URL の互換維持や集計に使う */
export function categoryOfKind(kind: ListingKind): CategorySlug | null {
  for (const slug of CATEGORY_SLUGS) {
    if ((CATEGORIES[slug].kinds as readonly string[]).includes(kind)) {
      return slug;
    }
  }
  return null;
}
