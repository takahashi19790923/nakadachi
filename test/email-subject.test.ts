import { describe, expect, it } from "vitest";

import { contactSchema } from "~/domain/validation/interaction";
import { singleLineSubject } from "~/server/services/email/email-service.server";

/**
 * 件名は1行（監査 SEC-05）。
 *
 * 件名はメールのヘッダになる。利用者の入力（問い合わせの件名）が入る経路が
 * あるので、入口（フォームの検証）と出口（送信）の両方で改行を潰す。
 */

// 改行・制御文字・行と段落の区切り。ソースに見えない文字を書かないよう、番号から作る。
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const NEL = String.fromCharCode(0x85);
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

describe("singleLineSubject（送信の出口）", () => {
  it("改行と制御文字を空白1つに潰す", () => {
    expect(singleLineSubject(`お問い合わせ${CR}${LF}Bcc: evil@example.test`)).toBe(
      "お問い合わせ Bcc: evil@example.test",
    );
    expect(singleLineSubject(`a${LF}b${CR}c${TAB}d`)).toBe("a b c d");
    expect(singleLineSubject(`a${NEL}b${LINE_SEP}c${PARA_SEP}d`)).toBe("a b c d");
  });

  it("前後の改行は落とす", () => {
    expect(singleLineSubject(`${LF}件名${CR}${LF}`)).toBe("件名");
  });

  it("普通の件名はそのまま", () => {
    expect(singleLineSubject("【なかだち】ログイン用のコード")).toBe(
      "【なかだち】ログイン用のコード",
    );
  });
});

describe("問い合わせの件名（入口）", () => {
  function parseSubject(subject: string) {
    return contactSchema.safeParse({
      email: "someone@example.test",
      subject,
      body: "お問い合わせの本文です。十文字以上あります。",
      turnstileToken: "token",
    });
  }

  it("改行は空白になって通る", () => {
    const parsed = parseSubject(`件名${CR}${LF}Bcc: evil@example.test`);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.subject).toBe("件名 Bcc: evil@example.test");
    }
  });

  it("改行だけの件名は空として弾く", () => {
    expect(parseSubject(`${CR}${LF}${LF}`).success).toBe(false);
  });
});
