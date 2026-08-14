/**
 * Cookie の読み書き。
 *
 * 小さな処理だが、属性を1つ落とすと防御が丸ごと消える種類のコードなので、
 * 1か所にまとめて、各所で組み立て直さないようにしている。
 */

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

export interface CookieOptions {
  /** __Host- 接頭辞を名乗るなら Secure・Path=/・Domain 無しが必須。1つ欠けると捨てられる */
  secure: boolean;
  maxAgeSeconds?: number;
  /**
   * SameSite。
   * セッションは Lax。Strict にすると、決済事業者やメールのリンクから
   * 戻ってきたときにログイン状態が消えて見える。
   * 管理画面の通過証は Strict（外部からの遷移で使わせない）。
   */
  sameSite?: "Lax" | "Strict" | "None";
  httpOnly?: boolean;
  path?: string;
}

export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.floor(options.maxAgeSeconds)}`);
  }
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function expireCookie(name: string, options: CookieOptions): string {
  return serializeCookie(name, "", { ...options, maxAgeSeconds: 0 });
}
