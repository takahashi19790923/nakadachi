/**
 * 環境変数と binding の入口。
 *
 * ★ここ以外で env を直接読まないこと。★ 未設定に気づかないまま動く経路を
 * 作らないため、必要な値は必ずこのファイルの getter を通す。
 *
 * wrangler types が生成する Env は vars をリテラル型に狭めるうえ、secret を
 * 含まない（wrangler.jsonc に書かないので当然）。境界でのキャストは1回だけ
 * ここで行い、代わりに実行時の検証を入れる。
 */
import { ConfigurationError } from "./errors.ts";

export interface AppEnv {
  // ── binding ────────────────────────────────────────────────
  MEDIA: R2Bucket;

  // ── 公開してよい設定（wrangler.jsonc の vars）────────────────
  ENVIRONMENT: "development" | "preview" | "production";
  APP_ORIGIN: string;
  SESSION_COOKIE_NAME: string;
  MAIL_FROM: string;
  EMAIL_REPLY_TO: string;
  EXPECTED_CURRENCY: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_EXPECTED_HOSTS: string;

  // ── secret（wrangler secret put / .dev.vars）─────────────────
  DATABASE_URL?: string;
  SESSION_SECRET?: string;
  EMAIL_ENCRYPTION_KEY?: string;
  EMAIL_INDEX_KEY?: string;
  /*
   * 発信者情報（IP）の暗号化鍵。
   * ★セッションやメールの鍵と分ける。★ 1つ漏れたときに、
   * 「誰がどこから」まで一緒に漏れるのを避けるため。
   */
  ACCESS_LOG_KEY?: string;
  RESEND_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  ADMIN_BASIC_AUTH_USER?: string;
  ADMIN_BASIC_AUTH_PASS?: string;
}

/** 起動時に必ず揃っていなければならない値（無いと何も動かない） */
const ALWAYS_REQUIRED = [
  "APP_ORIGIN",
  "SESSION_COOKIE_NAME",
  "ENVIRONMENT",
] as const satisfies readonly (keyof AppEnv)[];

/**
 * Workers から渡ってきた env をアプリの型として扱えるようにする。
 * 足りない値があれば、その場で落とす（黙って undefined を配らない）。
 */
export function toAppEnv(env: unknown): AppEnv {
  if (typeof env !== "object" || env === null) {
    throw new ConfigurationError("env が渡されていません");
  }
  const candidate = env as AppEnv;
  const missing = ALWAYS_REQUIRED.filter((key) => !candidate[key]);
  if (missing.length > 0) {
    // 値そのものは出さない。名前だけでも設定漏れは特定できる。
    throw new ConfigurationError(
      `必須の設定が未投入です: ${missing.join(", ")}`,
    );
  }
  return candidate;
}

/**
 * secret を取り出す。未設定なら例外。
 *
 * ★fail-open にしないこと。★「鍵が無ければ検査を飛ばす」と書くと、
 * 投入漏れのまま何事もなく動き、ボット対策や署名検証が外れたことに
 * 誰も気づかない。無ければ 503 で止まるほうが、必ず発見される。
 */
export function requireSecret(env: AppEnv, key: RequiredSecretKey): string {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationError(`${key} が未設定です`);
  }
  return value.trim();
}

export type RequiredSecretKey =
  | "DATABASE_URL"
  | "SESSION_SECRET"
  | "EMAIL_ENCRYPTION_KEY"
  | "EMAIL_INDEX_KEY"
  | "ACCESS_LOG_KEY"
  | "RESEND_API_KEY"
  | "STRIPE_SECRET_KEY"
  | "STRIPE_WEBHOOK_SECRET"
  | "TURNSTILE_SECRET_KEY"
  | "ADMIN_BASIC_AUTH_USER"
  | "ADMIN_BASIC_AUTH_PASS";

/** secret が入っているかだけを見る（値は返さない）。健全性の確認に使う */
export function hasSecret(env: AppEnv, key: RequiredSecretKey): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "";
}

export function isProduction(env: AppEnv): boolean {
  return env.ENVIRONMENT === "production";
}

/** 本番と preview では https。ローカルだけ http を許す */
export function isSecureOrigin(env: AppEnv): boolean {
  return env.APP_ORIGIN.startsWith("https://");
}

/**
 * Turnstile で受け入れるホスト名。
 * ★共有ウィジェットを全サービスで使い回しているため、ここが空だと
 * 他サービス向けに解かれたトークンがそのまま通る。★
 */
export function turnstileExpectedHosts(env: AppEnv): string[] {
  return env.TURNSTILE_EXPECTED_HOSTS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
