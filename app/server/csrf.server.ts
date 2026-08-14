import { hmacSha256Hex, randomToken, timingSafeEqual } from "./crypto.server.ts";
import { requireSecret, type AppEnv } from "./env.server.ts";
import { AppError } from "./errors.ts";

/**
 * CSRF 対策。防御を2枚重ねている。
 *
 *  1. Origin（無ければ Referer）が自分のオリジンと一致するか
 *     → 最近のブラウザは状態を変える要求に必ず Origin を付ける。
 *       単純で、取りこぼしが無い。
 *  2. フォームに埋めた署名付きトークンと Cookie の突き合わせ
 *     → 1 が効かない古い経路や、将来 SameSite の扱いが変わった場合の保険。
 *
 * どちらか一方でも欠けると通さない（fail-close）。
 */

const CSRF_TOKEN_FIELD = "_csrf";
const CSRF_COOKIE_SUFFIX = "_csrf";

export class CsrfError extends AppError {
  constructor(detail: string) {
    super(
      "csrf_mismatch",
      "セッションの確認に失敗しました。ページを再読み込みしてお試しください。",
      { detail },
    );
    this.name = "CsrfError";
  }
}

/** 状態を変える要求か。GET/HEAD/OPTIONS は対象外 */
export function isStateChanging(request: Request): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
}

/**
 * Origin の照合。
 *
 * ★完全一致で比べる。★ startsWith にすると
 * https://nakadachi.rewrite-co.com.evil.example が通る。
 * Origin が無い場合は Referer のオリジン部分で代替し、どちらも無ければ拒否。
 */
export function assertSameOrigin(request: Request, env: AppEnv): void {
  if (!isStateChanging(request)) return;

  const origin = request.headers.get("origin");
  if (origin) {
    if (origin !== env.APP_ORIGIN) {
      throw new CsrfError(`origin mismatch: ${origin}`);
    }
    return;
  }

  const referer = request.headers.get("referer");
  if (referer) {
    let refererOrigin: string;
    try {
      refererOrigin = new URL(referer).origin;
    } catch {
      throw new CsrfError("referer unparsable");
    }
    if (refererOrigin !== env.APP_ORIGIN) {
      throw new CsrfError(`referer mismatch: ${refererOrigin}`);
    }
    return;
  }

  throw new CsrfError("origin and referer both missing");
}

export function csrfCookieName(env: AppEnv): string {
  return `${env.SESSION_COOKIE_NAME}${CSRF_COOKIE_SUFFIX}`;
}

/**
 * フォームへ埋めるトークンを作る。
 *
 * 中身は「乱数.署名」。署名の材料に Cookie 側の乱数を含めるので、
 * 攻撃者はフォームの値だけを推測しても作れない。
 */
export async function issueCsrfToken(env: AppEnv): Promise<{
  token: string;
  cookieValue: string;
}> {
  const cookieValue = randomToken(24);
  const signature = await csrfSignature(env, cookieValue);
  return { token: `${cookieValue}.${signature}`, cookieValue };
}

/** 既に Cookie がある場合に、同じ対のトークンを組み立て直すために使う */
export async function csrfSignature(
  env: AppEnv,
  cookieValue: string,
): Promise<string> {
  const secret = requireSecret(env, "SESSION_SECRET");
  return hmacSha256Hex(secret, `csrf:${cookieValue}`);
}

/** フォームから届いたトークンを検証する */
export async function verifyCsrfToken(
  env: AppEnv,
  submitted: unknown,
  cookieValue: string | null,
): Promise<void> {
  if (typeof submitted !== "string" || !cookieValue) {
    throw new CsrfError("csrf token or cookie missing");
  }
  const dot = submitted.indexOf(".");
  if (dot === -1) throw new CsrfError("csrf token malformed");

  const value = submitted.slice(0, dot);
  const signature = submitted.slice(dot + 1);

  if (!(await timingSafeEqual(value, cookieValue))) {
    throw new CsrfError("csrf cookie mismatch");
  }

  const expected = await csrfSignature(env, value);
  if (!(await timingSafeEqual(expected, signature))) {
    throw new CsrfError("csrf signature mismatch");
  }
}

/**
 * 状態を変える要求の入口で必ず呼ぶ。Origin 照合とトークン照合の両方を行う。
 * ★アクションの先頭で呼ぶこと。★ 後ろに置くと、検証前に副作用が走る。
 */
export async function assertCsrf(
  request: Request,
  env: AppEnv,
  formData: FormData,
): Promise<void> {
  assertSameOrigin(request, env);
  await verifyCsrfToken(
    env,
    formData.get(CSRF_TOKEN_FIELD),
    readCookieValue(request, csrfCookieName(env)),
  );
}

function readCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index !== -1 && part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

export { CSRF_TOKEN_FIELD };
