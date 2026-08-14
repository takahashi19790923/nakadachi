/**
 * エラーの型。
 *
 * ★利用者向けの文言と、内部の詳細を必ず分ける。★
 * message は画面にそのまま出る。原因の詳細（SQL・スタック・外部APIの応答）は
 * cause 側へ入れ、ログにだけ残す。混ぜると、エラー画面から内部構造が漏れる。
 */

export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "rate_limited"
  | "turnstile_failed"
  | "csrf_mismatch"
  | "conflict"
  | "payment_failed"
  | "configuration"
  | "internal";

const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  rate_limited: 429,
  turnstile_failed: 400,
  csrf_mismatch: 403,
  conflict: 409,
  payment_failed: 402,
  configuration: 503,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** ログにだけ残す内部情報。画面へ出さない */
  readonly detail?: string;
  /** 画面に出してよい補足（入力欄ごとのエラーなど） */
  readonly fields?: Record<string, string>;

  constructor(
    code: ErrorCode,
    userMessage: string,
    options: { detail?: string; fields?: Record<string, string>; cause?: unknown } = {},
  ) {
    super(userMessage, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.detail = options.detail;
    this.fields = options.fields;
  }
}

export class ConfigurationError extends AppError {
  constructor(detail: string) {
    // 利用者には設定名すら見せない。運用者はログで detail を見る。
    super("configuration", "ただいまご利用いただけません。時間をおいてお試しください。", {
      detail,
    });
    this.name = "ConfigurationError";
  }
}

/**
 * 画面ごと差し替わるエラー（404・403）は、AppError ではなく Response を投げる。
 *
 * ★React Router は「投げられたのが Response ならそのステータスで応答し、
 * そうでなければ 500 として扱う」。★ AppError は Error なので、status に 404 を
 * 持っていても無視される。文言は ErrorBoundary が「見つかりません」と出すため、
 * 画面を見ているかぎり正常に見え、実際には 500 が返っている——という形になる。
 * 検索エンジンには 500 と伝わるので、消したはずの URL が索引に残り続ける。
 *
 * Response にしておくと、クライアント側の遷移でも isRouteErrorResponse が
 * 真になり、同じ 404 画面が出る。AppError のままだと、ハイドレーション後の
 * 遷移では中身が伏せられて「問題が発生しました」に化ける。
 *
 * ★本文は空にする。★ detail には ID や理由が入る。Response に載せると
 * そのままブラウザへ出る。detail はログにだけ残す。
 */
function httpError(code: ErrorCode, detail: string | undefined): Response {
  if (detail) {
    // ここには per-request の logger が無い（純粋関数として呼ばれるため）。
    // 直前後に出る「GET /path 404」の行と並ぶので、突き合わせはできる。
    console.warn(`[${code}] ${detail}`);
  }
  return new Response(null, { status: STATUS_BY_CODE[code] });
}

export const unauthorized = (detail?: string) =>
  httpError("unauthorized", detail);

export const forbidden = (detail?: string) => httpError("forbidden", detail);

/**
 * 見つからない。
 *
 * ★「権限が無い」を 403 で返すか 404 で返すかは意図的に選ぶ。★
 * 他人の下書きや他人の会話は 404 を返す。403 だと「その ID の投稿は存在する」
 * ことが分かってしまい、ID の総当たりで存在確認ができてしまう。
 */
export const notFound = (detail?: string) => httpError("not_found", detail);

export const rateLimited = (detail?: string) =>
  new AppError(
    "rate_limited",
    "操作が続けて行われました。しばらく時間をおいてからお試しください。",
    { detail },
  );

export const validationFailed = (
  fields: Record<string, string>,
  detail?: string,
) =>
  new AppError("validation_failed", "入力内容をご確認ください。", {
    fields,
    detail,
  });

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * 例外を、画面に出してよい形へ落とす。
 * AppError 以外は必ず一般的な文言に置き換える（内部エラーを露出させない）。
 */
export function toPublicError(error: unknown): {
  status: number;
  code: ErrorCode;
  message: string;
  fields?: Record<string, string>;
} {
  if (isAppError(error)) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      fields: error.fields,
    };
  }
  return {
    status: 500,
    code: "internal",
    message:
      "処理中に問題が発生しました。時間をおいてもう一度お試しください。",
  };
}
