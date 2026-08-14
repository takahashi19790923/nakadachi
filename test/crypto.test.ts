import { describe, expect, it } from "vitest";

import {
  decryptString,
  emailIndexHmac,
  encryptString,
  generateOtp,
  hashIp,
  normalizeEmail,
  randomToken,
  sha256Hex,
  timingSafeEqual,
  toBase64Url,
  fromBase64Url,
} from "~/server/crypto.server";

/** テスト用の鍵。32バイトを base64url にしたもの（本物ではない） */
const KEY_A = toBase64Url(new Uint8Array(32).fill(1));
const KEY_B = toBase64Url(new Uint8Array(32).fill(2));

describe("base64url", () => {
  it("往復できる", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(
      Array.from(bytes),
    );
  });

  it("URL に入れて安全な文字だけを使う", () => {
    const bytes = new Uint8Array(64);
    crypto.getRandomValues(bytes);
    expect(toBase64Url(bytes)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("乱数", () => {
  it("トークンが重複しない", () => {
    const values = new Set(Array.from({ length: 5000 }, () => randomToken(32)));
    expect(values.size).toBe(5000);
  });

  it("OTP は6桁の数字", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateOtp()).toMatch(/^[0-9]{6}$/);
    }
  });

  it("★OTP の各桁に偏りが無い★（剰余の偏りを捨てている）", () => {
    const counts = new Array<number>(10).fill(0);
    for (let i = 0; i < 20_000; i += 1) {
      const first = generateOtp()[0];
      if (first) counts[Number(first)] = (counts[Number(first)] ?? 0) + 1;
    }
    // 一様なら各 2000 回前後。±25% を超えるなら偏りを疑う。
    for (const count of counts) {
      expect(count).toBeGreaterThan(1500);
      expect(count).toBeLessThan(2500);
    }
  });
});

describe("ハッシュと比較", () => {
  it("SHA-256 は 64文字の16進", async () => {
    expect(await sha256Hex("test")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("同じ入力なら同じ結果", async () => {
    expect(await sha256Hex("nakadachi")).toBe(await sha256Hex("nakadachi"));
  });

  it("定数時間の比較が正しく判定する", async () => {
    expect(await timingSafeEqual("secret", "secret")).toBe(true);
    expect(await timingSafeEqual("secret", "secrez")).toBe(false);
    // 長さが違っても例外にならず false を返す
    expect(await timingSafeEqual("secret", "secret-longer")).toBe(false);
    expect(await timingSafeEqual("", "")).toBe(true);
  });
});

describe("メールアドレスの暗号化", () => {
  it("暗号化して復号すると元に戻る", async () => {
    const email = "user@example.com";
    const encrypted = await encryptString(KEY_A, email);
    expect(encrypted).not.toContain("user");
    expect(await decryptString(KEY_A, encrypted)).toBe(email);
  });

  it("★同じ平文でも毎回違う暗号文になる★（IV が毎回変わる）", async () => {
    const first = await encryptString(KEY_A, "user@example.com");
    const second = await encryptString(KEY_A, "user@example.com");
    expect(first).not.toBe(second);
  });

  it("★別の鍵では復号できない★", async () => {
    const encrypted = await encryptString(KEY_A, "user@example.com");
    await expect(decryptString(KEY_B, encrypted)).rejects.toThrow();
  });

  it("鍵の長さが違えば設定エラーになる", async () => {
    await expect(
      encryptString(toBase64Url(new Uint8Array(16)), "x"),
    ).rejects.toThrow();
  });
});

describe("メールアドレスの索引", () => {
  it("正規化してから作る（大文字・前後の空白で別人にならない）", async () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
    const a = await emailIndexHmac(KEY_A, "User@Example.com");
    const b = await emailIndexHmac(KEY_A, " user@example.com ");
    expect(a).toBe(b);
  });

  it("★暗号化とは別の鍵を使う（値が変わる）★", async () => {
    const withA = await emailIndexHmac(KEY_A, "user@example.com");
    const withB = await emailIndexHmac(KEY_B, "user@example.com");
    expect(withA).not.toBe(withB);
  });

  it("別のアドレスは別の索引になる", async () => {
    const first = await emailIndexHmac(KEY_A, "a@example.com");
    const second = await emailIndexHmac(KEY_A, "b@example.com");
    expect(first).not.toBe(second);
  });
});

describe("IP のハッシュ", () => {
  it("★鍵付きにしている（鍵が変われば値も変わる）★", async () => {
    const withA = await hashIp(KEY_A, "192.0.2.1");
    const withB = await hashIp(KEY_B, "192.0.2.1");
    expect(withA).not.toBe(withB);
  });

  it("元の値が読み取れない形になる", async () => {
    const hashed = await hashIp(KEY_A, "192.0.2.1");
    expect(hashed).not.toContain("192");
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
  });
});
