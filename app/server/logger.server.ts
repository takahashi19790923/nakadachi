/**
 * 構造化ログ。
 *
 * ★個人情報と秘密情報を出さない。★
 * メールアドレス・氏名・IP・トークン・APIキー・接続文字列は、そのままでは
 * 絶対に出力しない。マスク関数を通すか、ハッシュにしてから渡す。
 *
 * 「あとで消せばいい」は効かない。Cloudflare のログは外部へ転送される
 * こともあり、一度出した行を取り消す手段が無い。
 */
import { isAppError } from "./errors.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

/** 出力してはいけない鍵の名前。含まれていたら値を伏せる */
const REDACT_KEYS = [
  "email",
  "password",
  "token",
  "secret",
  "key",
  "authorization",
  "cookie",
  "signature",
  "connectionstring",
  "database_url",
  "ip",
  "phone",
  "address",
];

function shouldRedact(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACT_KEYS.some((needle) => lower.includes(needle));
}

function redactFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = shouldRedact(key) ? "[redacted]" : value;
  }
  return out;
}

/**
 * メールアドレスをログに出したいときの唯一の形。
 * 先頭1文字とドメインだけを残す（a***@example.com）。
 * 完全一致の追跡が要るなら、ログではなく HMAC を使うこと。
 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "[invalid-email]";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, error?: unknown, fields?: LogFields): void;
  /** リクエスト単位の相関 ID。ログを追うためだけに使う */
  readonly requestId: string;
}

export function createLogger(options: {
  requestId: string;
  environment: string;
}): Logger {
  const base = {
    requestId: options.requestId,
    env: options.environment,
  };

  function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
    const line = JSON.stringify({
      level,
      message,
      ...base,
      ...redactFields(fields),
    });
    // 構造化ログ以外で標準出力に書かない（eslint の no-console で強制）。
    if (level === "error") console.error(line);
    else console.warn(line);
  }

  return {
    requestId: options.requestId,
    debug(message, fields) {
      if (options.environment !== "production") emit("debug", message, fields);
    },
    info(message, fields) {
      emit("info", message, fields);
    },
    warn(message, fields) {
      emit("warn", message, fields);
    },
    error(message, error, fields = {}) {
      // AppError の detail は運用者向け。ここでだけ出す（画面には出さない）。
      const detail = isAppError(error) ? error.detail : undefined;
      const name = error instanceof Error ? error.name : typeof error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      emit("error", message, {
        ...fields,
        errorName: name,
        // 例外メッセージに個人情報が混ざる可能性があるため長さを抑える。
        errorMessage: errorMessage.slice(0, 300),
        detail: detail?.slice(0, 300),
      });
    },
  };
}

/** ログを捨てる実装。単体テストで使う */
export const nullLogger: Logger = {
  requestId: "test",
  debug() {},
  info() {},
  warn() {},
  error() {},
};
