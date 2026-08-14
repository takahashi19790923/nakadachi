/**
 * 暗号まわりの共通処理。WebCrypto だけを使う（Workers と Node の両方で動く）。
 *
 * 方針
 *  - 秘密の値は「保存するときはハッシュ、照合は定数時間」で扱う
 *  - メールアドレスは暗号化して保存し、検索は別鍵の HMAC で行う
 *  - 乱数は必ず crypto.getRandomValues から取る（Math.random を使わない）
 */
import { ConfigurationError } from "./errors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── 変換 ──────────────────────────────────────────────────────────

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ── 乱数 ──────────────────────────────────────────────────────────

/** セッショントークンやマジックリンクの乱数。既定32バイト */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/**
 * 6桁の OTP。
 *
 * 剰余をそのまま使うと下位の数字が出やすくなる（modulo bias）。
 * 桁ごとに 0-9 の範囲外を捨てて引き直すことで偏りを無くしている。
 * 6桁は総当たりで100万通りなので、★試行回数の制限とレート制限が前提★。
 */
export function generateOtp(digits = 6): string {
  let out = "";
  const buffer = new Uint8Array(1);
  while (out.length < digits) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] ?? 0;
    // 250 以上は捨てる（250 = 25 * 10 なので、ここまでなら 10 で割っても偏らない）
    if (value >= 250) continue;
    out += String(value % 10);
  }
  return out;
}

// ── ハッシュ・HMAC ────────────────────────────────────────────────

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const data = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return toHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(
  key: string,
  message: string,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(message),
  );
  return toHex(new Uint8Array(signature));
}

/**
 * 定数時間の比較。
 * 長さの違いまで隠すため、両方を SHA-256 にかけてから1バイトずつ比べる。
 * 早期 return にすると、一致した先頭の長さが応答時間から読み取れる。
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  if (ha.length !== hb.length) return false;
  let diff = 0;
  for (let i = 0; i < ha.length; i++) {
    diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  }
  return diff === 0;
}

// ── メールアドレスの暗号化と索引 ──────────────────────────────────

async function importAesKey(base64UrlKey: string): Promise<CryptoKey> {
  const raw = fromBase64Url(base64UrlKey);
  if (raw.byteLength !== 32) {
    throw new ConfigurationError(
      "EMAIL_ENCRYPTION_KEY は base64url の32バイトである必要があります",
    );
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * AES-GCM で暗号化する。
 * IV は毎回新しく作り、暗号文の先頭に連結して保存する（IV は秘密ではない）。
 */
export async function encryptString(
  base64UrlKey: string,
  plaintext: string,
): Promise<string> {
  const key = await importAesKey(base64UrlKey);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    encoder.encode(plaintext),
  );
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);
  return toBase64Url(combined);
}

export async function decryptString(
  base64UrlKey: string,
  payload: string,
): Promise<string> {
  const key = await importAesKey(base64UrlKey);
  const combined = fromBase64Url(payload);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ciphertext,
  );
  return decoder.decode(plaintext);
}

/**
 * メールアドレスの検索用索引。
 *
 * ★暗号化とは別の鍵を使う。★ 同じ鍵を使い回すと、索引が漏れたときに
 * 本文の解読にも近づく。正規化（小文字化・前後の空白除去）をここで一度だけ
 * 行い、「大文字で登録すると別人になる」事故を防ぐ。
 */
export async function emailIndexHmac(
  indexKey: string,
  email: string,
): Promise<string> {
  return hmacSha256Hex(indexKey, normalizeEmail(email));
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * IP アドレスのハッシュ。
 *
 * 生の IP を保存しない。レート制限と不正利用の追跡に足りる粒度だけを残す。
 * 鍵付きにしているのは、IPv4 は全空間が43億通りしかなく、鍵無しのハッシュ
 * だと総当たりで元に戻せてしまうため。
 */
export async function hashIp(secret: string, ip: string): Promise<string> {
  return hmacSha256Hex(secret, `ip:${ip}`);
}

/**
 * ログイン用コード（6桁）のハッシュ。
 *
 * ★鍵無しの sha256 で保存してはいけない。★ 6桁は100万通りしかなく、
 * DB が漏れた時点で総当たりの表と突き合わせるだけで全件が元に戻る。
 * 「ハッシュ化して保存している」という体裁だけが残り、実質は平文と変わらない。
 * 32バイトのトークンは空間が広いので素の sha256 でよいが、コードは別扱いにする。
 *
 * トークン ID を混ぜているのは、同じコードが同時に複数発行されたときに
 * 同じハッシュにならないようにするため（どれか1つが割れても他へ広がらない）。
 */
export async function otpHash(
  secret: string,
  tokenId: string,
  otp: string,
): Promise<string> {
  return hmacSha256Hex(secret, `otp:${tokenId}:${otp}`);
}
