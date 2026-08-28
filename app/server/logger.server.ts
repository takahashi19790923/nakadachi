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

/**
 * 伏字にしない、と決めてあるキー。
 *
 * ★すでに «出してよい形» に加工してある値。★ 部分一致の伏字は
 * これらを巻き込む —— "recipient" には "ip" が、"idempotencyKey" には
 * "key" が入っているため。結果、
 *   - maskEmail で伏せたはずの宛先が [redacted] になり、helper が死んでいた
 *   - 二重送信を追える唯一の手がかり（冪等キー）が消えていた
 * という状態だった（2026-08-25 の公開前監査で指摘）。
 *
 * ★足すときは «その値が生の個人情報でないこと» を確かめること。★
 */
const NEVER_REDACT = new Set([
  "recipient", // maskEmail 済み（先頭1文字＋ドメイン）
  "recipientHmac",
  "idempotencyKey",
  "ipHash", // 鍵付きハッシュ。元に戻せない
]);

function shouldRedact(key: string): boolean {
  if (NEVER_REDACT.has(key)) return false;
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
    /*
     * ★重要度をそのまま渡す。★ 以前は error 以外を全部 console.warn へ
     * 出していたので、Cloudflare の画面では「cron が終わった」も
     * 「メールを送った」も警告として並んだ。★「警告だけ見せて」が
     * 全ログとほぼ同じ意味になり、量で気づく仕組みが作れない。★
     */
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    // ここが info/debug の唯一の出口。規則の狙いは「各所で console を
    // 直に使わせない」ことなので、この1行だけ例外にする。
    // eslint-disable-next-line no-console
    else console.log(line);
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
        // ★cause を必ず出す。★ Drizzle は失敗した SQL を message にして、
        // 「なぜ落ちたか」（権限・制約違反・接続断）を cause に入れる。
        // message だけ記録していると、本番のログに SQL とパラメータだけが
        // 並び、原因が1つも分からない。実際にそれで詰まった。
        errorCause: causeChain(error),
        detail: detail?.slice(0, 300),
      });
    },
  };
}

/**
 * cause をたどって1行にまとめる。
 *
 * ★個人情報が混ざりうるので長さを抑える。★ ただし短くしすぎると
 * 肝心の理由（"permission denied for table users" など）が切れる。
 */
function causeChain(error: unknown): string | undefined {
  const parts: string[] = [];
  let current: unknown = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; depth < 3 && current != null; depth += 1) {
    let text: string;
    if (current instanceof Error) {
      text = current.message;
    } else if (typeof current === "string") {
      text = current;
    } else {
      // オブジェクトを素で文字列化すると [object Object] になる。
      text = JSON.stringify(current) ?? "不明な原因";
    }
    parts.push(text.split("\n")[0]!.slice(0, 200));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.length > 0 ? parts.join(" ← ") : undefined;
}

/** ログを捨てる実装。単体テストで使う */
export const nullLogger: Logger = {
  requestId: "test",
  debug() {},
  info() {},
  warn() {},
  error() {},
};
