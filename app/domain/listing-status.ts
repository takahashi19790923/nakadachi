/**
 * 投稿のステータスと、許される遷移。
 *
 * ★遷移の判断は必ずここを通す。★ 画面や個々のハンドラで status を直接
 * 書き換えると、「決済していないのに公開された」「管理者が止めた投稿を
 * 本人が戻せた」といった穴が、どこか1箇所の書き漏らしから開く。
 *
 * このファイルは純粋関数だけで、DB もネットワークも触らない。
 * クライアントからも import してよい（表示の出し分けに使う）。
 */

export const LISTING_STATUSES = [
  /** 下書き。課金していない。本人と管理者だけが見られる */
  "draft",
  /** 決済待ち。Checkout Session を作った直後 */
  "payment_pending",
  /** 決済確認中。コンビニ払いなど非同期の決済手段で使う */
  "payment_processing",
  /** 公開中。検索・一覧・詳細に出る唯一の状態 */
  "published",
  /** 掲載終了。本人が終了させた */
  "closed",
  /** 管理者による却下 */
  "rejected",
  /** 管理者による非公開。返金は自動で行わない */
  "suspended",
  /** 期限切れ */
  "expired",
  /** 論理削除 */
  "deleted",
] as const;

export type ListingStatus = (typeof LISTING_STATUSES)[number];

/**
 * 管理画面の「投稿の状態」に出さない状態。
 *
 * deleted は論理削除で、件数の問い合わせ自体が deleted_at is null で
 * 絞っているため常に 0 になる。並べても意味が無い。
 */
export const ADMIN_HIDDEN_STATUSES: readonly ListingStatus[] = ["deleted"];

/**
 * 管理画面に並べる状態。
 *
 * ★一覧を手で書かない。★ 以前は7つを直接並べていて、
 * ★payment_processing（コンビニ払いなどの入金確認中）が抜けていた★。
 * 支払い手段はダッシュボードの設定で増やせるので、後払いを有効にした日から
 * 「入金確認中で止まっている投稿」が管理画面のどこにも出なくなる。
 *
 * 状態を足したら自動でここに出る。出したくないものは
 * ADMIN_HIDDEN_STATUSES に、理由と一緒に書く。
 */
export const ADMIN_STATUS_TILES: readonly ListingStatus[] =
  LISTING_STATUSES.filter((s) => !ADMIN_HIDDEN_STATUSES.includes(s));

/** 誰による遷移か。API から呼ぶときに必ず渡す */
/**
 * 誰がその遷移を起こしたか。
 *
 * ★payment を system から分けている理由。★
 * 公開できるのは「支払いが成立した」と確認できた経路だけ、という
 * 決まりを表そのものに書くため。system をそのまま使うと、期限切れの
 * 取り込みや返金処理と同じ資格になり、★あとから足したサーバー処理が
 * 課金を通さずに公開できてしまう。★ 呼び出し箇所の少なさで守っている
 * うちは、増えた日に気づけない。
 *
 * payment を渡してよいのは、署名検証済み Webhook の支払い成立処理だけ。
 */
export type TransitionActor = "owner" | "system" | "admin" | "payment";

/**
 * 許可された遷移だけを列挙する。ここに無い組み合わせはすべて拒否。
 *
 * 「掲載終了 → 公開」が無いのは意図的。掲載終了後の再掲載は新しい投稿として
 * 作り直し、あらためて掲載料を課金する（ビジネスルール）。closed から
 * published へ戻せてしまうと、1回の課金で何度でも掲載できる穴になる。
 */
const ALLOWED: Readonly<
  Record<ListingStatus, Readonly<Partial<Record<ListingStatus, readonly TransitionActor[]>>>>
> = {
  draft: {
    payment_pending: ["owner"],
    /*
     * ★payment だけ。owner も admin も system も入れない。★
     *
     * 通常は payment_pending を経由する。ここが要るのは、支払いの成立と
     * 決済の失効が前後して届いたとき。失効の通知が先に着くと投稿は
     * 下書きへ戻り、そのあとに支払い成立が届く。届く順序は決済事業者側の
     * 都合で決まるので、こちらでは防ぎきれない。
     * ここが無いと ★110円を受け取ったのに掲載が出ない。★ 実際に踏んだ
     * （2026-08-16、preview）。
     *
     * 「課金を飛ばして公開できない」は、この表と payment という資格の
     * 組み合わせで守る。payment を渡すのは、金額・通貨・metadata を
     * 照合し終えた支払い成立処理だけ。
     */
    published: ["payment"],
    deleted: ["owner", "admin"],
  },
  payment_pending: {
    // カード決済は checkout.session.completed が payment_status=paid で届くので
    // ここから直接 published へ進む。
    published: ["payment"],
    // コンビニ・銀行振込など後払いの手段は確認中を挟む。
    payment_processing: ["system"],
    // 利用者が決済をやめた／Session が失効した場合は下書きへ戻す。再課金は発生しない。
    draft: ["owner", "system"],
    rejected: ["admin"],
    deleted: ["owner", "admin"],
  },
  payment_processing: {
    published: ["payment"],
    // 決済失敗。もう一度やり直せる状態へ戻す。
    payment_pending: ["system"],
    draft: ["system"],
    rejected: ["admin"],
    deleted: ["admin"],
  },
  published: {
    closed: ["owner"],
    expired: ["system"],
    // system が入っているのは返金・チャージバックのため。
    // ★返金したのに掲載が続く状態を作らない。★ 決済事業者側にもアプリの
    // エラーにも出ないので、放置すると誰も気づかない。
    suspended: ["admin", "system"],
    rejected: ["admin"],
    deleted: ["admin"],
  },
  closed: {
    deleted: ["owner", "admin"],
  },
  expired: {
    closed: ["owner"],
    deleted: ["owner", "admin"],
  },
  suspended: {
    // 管理者が判断を取り消したときだけ戻せる。本人は戻せない。
    published: ["admin"],
    closed: ["owner"],
    deleted: ["admin"],
  },
  rejected: {
    published: ["admin"],
    deleted: ["owner", "admin"],
  },
  // 論理削除は終端。ここから戻す運用が要るなら、監査ログ付きの別経路を作る。
  deleted: {},
};

export function isListingStatus(value: unknown): value is ListingStatus {
  return (
    typeof value === "string" &&
    (LISTING_STATUSES as readonly string[]).includes(value)
  );
}

export function canTransition(
  from: ListingStatus,
  to: ListingStatus,
  actor: TransitionActor,
): boolean {
  const actors = ALLOWED[from][to];
  return actors !== undefined && actors.includes(actor);
}

/** ある状態から、その主体が取れる遷移先の一覧。画面のボタン出し分けに使う */
export function allowedTransitions(
  from: ListingStatus,
  actor: TransitionActor,
): ListingStatus[] {
  return (Object.keys(ALLOWED[from]) as ListingStatus[]).filter((to) =>
    canTransition(from, to, actor),
  );
}

export class InvalidTransitionError extends Error {
  readonly from: ListingStatus;
  readonly to: ListingStatus;
  readonly actor: TransitionActor;

  constructor(from: ListingStatus, to: ListingStatus, actor: TransitionActor) {
    super(`投稿の状態を ${from} から ${to} へ変更できません（${actor}）`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
    this.actor = actor;
  }
}

export function assertTransition(
  from: ListingStatus,
  to: ListingStatus,
  actor: TransitionActor,
): void {
  if (!canTransition(from, to, actor)) {
    throw new InvalidTransitionError(from, to, actor);
  }
}

/** 誰でも見られる状態か。検索・一覧・詳細・sitemap の判定はすべてこれを使う */
export function isPubliclyVisible(status: ListingStatus): boolean {
  return status === "published";
}

/** 検索エンジンに載せてよいか（noindex の判定） */
export function isIndexable(status: ListingStatus): boolean {
  return isPubliclyVisible(status);
}

/** 掲載が終わった状態の総称。マイページのタブ分けに使う */
export function isFinished(status: ListingStatus): boolean {
  return (
    status === "closed" ||
    status === "expired" ||
    status === "rejected" ||
    status === "suspended"
  );
}

/** 決済の途中。ここで新しい Checkout Session を作ってよいかの判断に使う */
export function isAwaitingPayment(status: ListingStatus): boolean {
  return status === "payment_pending" || status === "payment_processing";
}

/** 画面に出す日本語のラベル */
export const LISTING_STATUS_LABEL: Readonly<Record<ListingStatus, string>> = {
  draft: "下書き",
  payment_pending: "決済待ち",
  payment_processing: "決済確認中",
  published: "公開中",
  closed: "掲載終了",
  rejected: "却下",
  suspended: "非公開（管理者）",
  expired: "期限切れ",
  deleted: "削除済み",
};
