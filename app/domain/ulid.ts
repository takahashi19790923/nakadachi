/**
 * ULID の生成と検証。
 *
 * 自前で持っている理由は2つ。
 *  1. 既製パッケージの多くが既定で Math.random を使う。ID の推測可能性は
 *     IDOR の前提条件になるので、暗号論的乱数から作ることを保証したい。
 *  2. Workers と Node の両方で同じコードが動く（crypto.getRandomValues のみ使用）。
 *
 * ★テスト用の ID を手で書かないこと。★ Crockford の base32 は I L O U を
 * 含まず、長さは26文字ちょうど。「01K2TESTMEDIA...」のような、それらしいが
 * 不正な ID を書くと検証に落ち、404 の原因が ID だと気づくまで実装を疑い続ける。
 * テストでも必ず ulid() を通すこと。
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32（I L O U を除く）
const TIME_LEN = 10;
const RANDOM_LEN = 16;
export const ULID_LENGTH = TIME_LEN + RANDOM_LEN;

const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/** 同一ミリ秒内で単調増加させるための直前の状態 */
let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let time = now;
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = time % 32;
    out = ENCODING[mod] + out;
    time = (time - mod) / 32;
  }
  return out;
}

function randomChars(): number[] {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  // 各バイトを 32 値へ落とす。1バイトから5ビットだけ使うので偏りは出ない。
  return Array.from(bytes, (b) => b & 0x1f);
}

/**
 * 直前の乱数列に 1 を足す（同一ミリ秒内の単調性を保つ）。
 * 桁上がりが最上位まで抜けた場合は、その ms 内では単調性を諦めて振り直す。
 */
function incrementRandom(values: number[]): number[] | null {
  const next = [...values];
  for (let i = next.length - 1; i >= 0; i--) {
    const v = next[i] ?? 0;
    if (v < 31) {
      next[i] = v + 1;
      return next;
    }
    next[i] = 0;
  }
  return null;
}

/**
 * ULID を1つ作る。
 * @param now テスト用に時刻を差し替えるためだけの引数。実運用では渡さない。
 */
export function ulid(now: number = Date.now()): string {
  let random: number[];
  if (now === lastTime) {
    random = incrementRandom(lastRandom) ?? randomChars();
  } else {
    lastTime = now;
    random = randomChars();
  }
  lastRandom = random;

  let out = encodeTime(now);
  for (const v of random) out += ENCODING[v];
  return out;
}

/** 形式として妥当な ULID か。DB を引く前にここで弾く（無駄な問い合わせを減らす） */
export function isUlid(value: unknown): value is string {
  return typeof value === "string" && ULID_RE.test(value);
}

/** ULID に埋まっている生成時刻（ミリ秒）。監査ログの検証などに使う */
export function ulidTimestamp(value: string): number | null {
  if (!isUlid(value)) return null;
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const index = ENCODING.indexOf(value[i] as string);
    if (index === -1) return null;
    time = time * 32 + index;
  }
  return time;
}
