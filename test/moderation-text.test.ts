import { describe, expect, it } from "vitest";

import { blockedCloseMessage } from "~/domain/listing-status";
import { stripInvisibleControls, trimmedString } from "~/domain/validation/common";
import {
  normalizeBannedWord,
  normalizeForMatching,
} from "~/server/repositories/moderation-repository.server";
import { collectPublicText } from "~/server/services/listing-service.server";

/**
 * 禁止語の照合と入力の掃除（2026-10 の監査 SEC-06・SEC-07・SEC-08・ADM-14・FN-10）。
 */
describe("normalizeForMatching（SEC-07）", () => {
  it("ゼロ幅文字・括弧・記号・絵文字を挟んでも同じ形になる", () => {
    const plain = normalizeForMatching("闇バイト");
    for (const variant of [
      "闇\u200Bバイト",
      "闇（バイト）",
      "闇+バイト",
      "闇：バイト",
      "闇🔥バイト",
      "闇・バイト",
    ]) {
      expect(normalizeForMatching(variant)).toBe(plain);
    }
  });

  it("★文の区切り（。、！？）はまたがない★（正当な投稿を弾かない。2026-10 のレビュー）", () => {
    expect(normalizeForMatching("貸し出し。子ども用です")).not.toContain("出し子");
    expect(normalizeForMatching("お引き受け、子供服")).not.toContain("受け子");
    expect(normalizeForMatching("貸し出し！子ども用")).not.toContain("出し子");
    expect(normalizeForMatching("貸し出し？子ども用")).not.toContain("出し子");
  });

  it("既知の限界: 区切りを挟んだ «闇。バイト» は block の照合では当たらない（公開時に確認待ちへ回す）", () => {
    expect(normalizeForMatching("闇。バイト")).not.toContain(normalizeForMatching("闇バイト"));
  });

  it("禁止語の保存の形は区切りも落とす（登録の画面では区切り入りの語を弾く）", () => {
    expect(normalizeBannedWord("出し。子")).toBe("出し子");
    expect(normalizeBannedWord("闇 バイト")).toBe(normalizeForMatching("闇バイト"));
  });

  it("長音符は文字として残す（«ゲーム» が «ゲム» にならない）", () => {
    expect(normalizeForMatching("ゲーム")).toBe("ゲーム");
  });

  it("記号だけの語は空になる（ADM-14: 登録の時点で弾く根拠）", () => {
    expect(normalizeForMatching("・・")).toBe("");
    expect(normalizeForMatching("--")).toBe("");
    expect(normalizeForMatching("**")).toBe("");
  });
});

describe("stripInvisibleControls（SEC-08）", () => {
  it("制御文字・ゼロ幅・双方向の制御を落とし、改行とタブは残す", () => {
    expect(stripInvisibleControls("題\u0000名")).toBe("題名");
    expect(stripInvisibleControls("見\u200Bえ\uFEFFな\u2060い")).toBe("見えない");
    expect(stripInvisibleControls("abc\u202Edef")).toBe("abcdef");
    expect(stripInvisibleControls("一行目\n二行目\tタブ")).toBe("一行目\n二行目\tタブ");
  });

  it("trimmedString を通した入力から落ちる", () => {
    expect(trimmedString.parse("\u202E表示名\u200B ")).toBe("表示名");
  });
});

describe("collectPublicText（SEC-06）", () => {
  it("文字の欄をすべて拾い、数値や日付は拾わない", () => {
    const text = collectPublicText({
      title: "題名",
      body: "本文",
      areaNote: "駅前",
      qualifications: "応募資格",
      priceJpy: 1000,
      publishedAt: new Date(),
      nested: { companyName: "会社名" },
    });
    for (const part of ["題名", "本文", "駅前", "応募資格", "会社名"]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain("1000");
  });
});

describe("blockedCloseMessage（FN-10）", () => {
  it("状態ごとに事実に合う説明を返す（«お支払いの確認中» は確認中のときだけ）", () => {
    expect(blockedCloseMessage("payment_processing")).toContain("お支払いの確認中");
    for (const status of ["suspended", "rejected", "closed", "deleted"] as const) {
      expect(blockedCloseMessage(status)).not.toContain("お支払いの確認中");
    }
    expect(blockedCloseMessage("suspended")).toContain("運営者が非公開");
  });
});
