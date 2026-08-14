import { expireCookie, readCookie, serializeCookie } from "./cookies.server.ts";
import { hmacSha256Hex, timingSafeEqual, toBase64Url } from "./crypto.server.ts";
import { isSecureOrigin, type AppEnv } from "./env.server.ts";

/**
 * 管理画面の第3層（追加のアクセス制限）。
 *
 * ■ ブラウザの Basic 認証ダイアログを使わない理由
 *   画面が fetch で API を呼ぶ作りだと、ブラウザは fetch の 401 に対して
 *   資格情報の窓を出さない。正しい値を知っていても入れなくなる。
 *   ★curl では通るので、実装者は「動いた」と誤認する。★
 *   過去に別サービスで実際にこれをやり、本番投入と curl 確認まで済ませて
 *   「3層認証が通る」と報告したが、人は一度も入れていなかった。
 *   守る強さは変えず、同じ ADMIN_BASIC_AUTH_USER / PASS を画面内の入力欄で
 *   受ける形にしている（「ベーシック認証等の追加アクセス制限」に当たる）。
 *
 * ■ 3層は独立している
 *   ここを通っても、第1層（メールでのログイン）と第2層（管理者用の再認証）は
 *   別に必要。逆も同じ。全サービスが同一メール・同一パスワードなので、
 *   Gmail が陥落したときに残るのはこの層だけになる。だから外さない。
 *
 * ■ 通過の証拠は署名付き Cookie
 *   中身は期限と署名だけで、資格情報そのものは入らない。
 *   ★署名鍵を利用者名とパスワードそのものから作っている。★
 *   値を変えれば、発行済みの証拠が全部その場で無効になる。
 */

export const GATE_COOKIE = "__Host-nakadachi_admin_gate";
/** 12時間。長いほど、端末を離れた隙に使える時間が延びる */
export const GATE_TTL_MS = 12 * 60 * 60 * 1000;

function credentials(env: AppEnv) {
  return {
    // 貼り付けで末尾に改行が入り、1文字違いで通らなくなる事故を防ぐ。
    user: String(env.ADMIN_BASIC_AUTH_USER ?? "").trim(),
    pass: String(env.ADMIN_BASIC_AUTH_PASS ?? "").trim(),
  };
}

async function sign(user: string, pass: string, expMs: number): Promise<string> {
  const hex = await hmacSha256Hex(`admin-gate:${user}:${pass}`, String(expMs));
  // hex をそのまま使わず短くする（Cookie の長さを抑えるだけの理由）。
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return toBase64Url(bytes);
}

/**
 * 入力を文字列として扱う。
 * FormData から来る値はファイルのこともあるので、文字列以外は空文字にする
 * （オブジェクトをそのまま String() にかけると "[object Object]" になり、
 * 意図しない一致の温床になる）。
 */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export type GateCheckResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "mismatch" };

/**
 * 入力された資格情報を照合する。
 * ★未設定なら通さない（fail-close）。★ 素通りにすると第3層が黙って消える。
 */
export async function checkGateCredentials(
  env: AppEnv,
  inputUser: unknown,
  inputPass: unknown,
): Promise<GateCheckResult> {
  const { user, pass } = credentials(env);
  if (!user || !pass) return { ok: false, reason: "not_configured" };

  // 両方を必ず評価してから判定する。早期 return にすると応答時間に差が出る。
  const [okUser, okPass] = await Promise.all([
    timingSafeEqual(asText(inputUser), user),
    timingSafeEqual(asText(inputPass), pass),
  ]);
  return okUser && okPass ? { ok: true } : { ok: false, reason: "mismatch" };
}

export async function issueGateCookie(
  env: AppEnv,
  nowMs: number = Date.now(),
): Promise<string> {
  const { user, pass } = credentials(env);
  const expMs = nowMs + GATE_TTL_MS;
  const value = `${expMs}.${await sign(user, pass, expMs)}`;
  return serializeCookie(GATE_COOKIE, value, {
    secure: isSecureOrigin(env),
    httpOnly: true,
    // 外部サイトからの遷移では付けない。管理操作は必ず管理画面から始める。
    sameSite: "Strict",
    path: "/",
    maxAgeSeconds: Math.floor(GATE_TTL_MS / 1000),
  });
}

export function clearGateCookie(env: AppEnv): string {
  return expireCookie(GATE_COOKIE, {
    secure: isSecureOrigin(env),
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
  });
}

/** 通過の証拠が本物で、期限内か */
export async function hasValidGate(
  request: Request,
  env: AppEnv,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const { user, pass } = credentials(env);
  if (!user || !pass) return false; // 未設定なら誰も通さない

  const raw = readCookie(request, GATE_COOKIE);
  if (!raw) return false;

  const dot = raw.indexOf(".");
  if (dot === -1) return false;

  const expMs = Number(raw.slice(0, dot));
  if (!Number.isFinite(expMs) || expMs <= nowMs) return false;

  return timingSafeEqual(await sign(user, pass, expMs), raw.slice(dot + 1));
}
