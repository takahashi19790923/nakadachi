import { describe, expect, it } from "vitest";

import { canonicalEmail, normalizeEmail } from "~/server/crypto.server";

/**
 * 「同じ受信箱に届くか」の判定。
 *
 * ★本人確認には使わない。★ 回数を数えることと、停止した相手に
 * 再登録させないことにだけ使う。ここを本人確認へ広げると、
 * 正規化を間違えたときに「他人のアカウントに入れる」まで一気に行く。
 */
describe("受信箱としてのアドレス", () => {
  it("★gmail は点と +タグを無視する（同じ受信箱に届くため）★", () => {
    const same = [
      "taro@gmail.com",
      "Taro@Gmail.com",
      "  taro@gmail.com  ",
      "t.a.r.o@gmail.com",
      "taro+shopping@gmail.com",
      "ta.ro+a+b@googlemail.com",
    ];
    const canonical = same.map(canonicalEmail);
    expect(new Set(canonical).size, canonical.join(" / ")).toBe(1);
    expect(canonical[0]).toBe("taro@gmail.com");
  });

  it("★gmail 以外では点を無視しない（別人になりうるため）★", () => {
    expect(canonicalEmail("t.a.ro@example.com")).toBe("t.a.ro@example.com");
    expect(canonicalEmail("taro@example.com")).not.toBe(
      canonicalEmail("ta.ro@example.com"),
    );
  });

  it("+タグは、どのドメインでも落とす", () => {
    expect(canonicalEmail("taro+abc@example.com")).toBe("taro@example.com");
    expect(canonicalEmail("taro+abc@outlook.jp")).toBe("taro@outlook.jp");
  });

  it("別人は別のままにする", () => {
    expect(canonicalEmail("taro@gmail.com")).not.toBe(
      canonicalEmail("jiro@gmail.com"),
    );
    expect(canonicalEmail("taro@gmail.com")).not.toBe(
      canonicalEmail("taro@example.com"),
    );
  });

  it("壊れた入力で潰れない", () => {
    // ローカル部が消えるとみんな同じになってしまう。元に戻す。
    expect(canonicalEmail("+tag@gmail.com")).toBe("+tag@gmail.com");
    expect(canonicalEmail(".@gmail.com")).toBe(".@gmail.com");
    // @ が無いものはそのまま（検証は別の層の担当）。
    expect(canonicalEmail("not-an-email")).toBe("not-an-email");
    expect(canonicalEmail("")).toBe("");
  });

  it("★本人確認用の正規化は変えていない★", () => {
    // こちらは大文字小文字と空白だけ。点も +タグもそのまま。
    expect(normalizeEmail(" T.a.ro+x@Gmail.com ")).toBe("t.a.ro+x@gmail.com");
    // 同じ入力から違う答えが出ること＝2つは別の用途のもの、という確認。
    expect(normalizeEmail("a+1@b.com")).not.toBe(canonicalEmail("a+1@b.com"));
  });
});
