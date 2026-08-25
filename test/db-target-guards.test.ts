import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseTarget, requireConnectionString } from "../scripts/db.ts";

/**
 * 接続先の取り違えを止める検査。
 *
 * ★ここは「事故が起きてから初めて価値が分かる」種類のコード。★
 * 普段は誰も踏まないので、壊れても気づけない。だから検査で固定する。
 *
 * とくに `drill`（復旧の練習用）は、流し込みが `--replace`
 * ＝**対象の表を全部空にしてから入れる**ので、本番を向いていたら
 * ★本番を消して古い写しで上書きする★。復旧の練習で本番を壊すのは
 * いちばん間抜けな壊し方なので、環境変数の貼り間違いで済む形にしない。
 */

const PRODUCTION_REF = "db.eejuzgepfjkfscutstdm.supabase.co";
const SCRATCH_REF = "db.abcdefghijklmnopqrst.supabase.co";
/**
 * 見本のパスワード。★短くしてあるのは意図的。★
 * scripts/check-secrets.mjs は8文字以上のパスワードを持つ接続文字列を
 * 「本物らしい」として止める。長い見本を書くと、この検査ファイル自体が
 * 毎回引っかかり、やがて «またあれか» で無視されるようになる。
 * ここで確かめたいのはホスト名と DB 名の判定なので、長さは要らない。
 */
const PW = "x";

const saved = { ...process.env };

beforeEach(() => {
  // 実際の .env が混ざらないように、対象の変数だけ消しておく。
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("DATABASE_URL")) delete process.env[key];
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("DATABASE_URL")) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

describe("接続先の指定", () => {
  it("知らない名前は受け付けない", () => {
    expect(() => parseTarget("prod")).toThrow(/接続先の指定が不正/);
    expect(() => parseTarget("本番")).toThrow(/接続先の指定が不正/);
  });

  it("drill を受け付ける", () => {
    expect(parseTarget("drill")).toBe("drill");
  });
});

describe("★復旧の練習用（drill）★", () => {
  function withDrill(url: string) {
    process.env.DATABASE_URL_DRILL = url;
    return () => requireConnectionString("drill");
  }

  it("★本番のプロジェクトを指していたら実行を拒む★", () => {
    /*
     * いちばん起きやすい事故：本番の接続文字列をそのまま
     * DATABASE_URL_DRILL に貼ってしまう。--replace が付くので
     * 本番が空になる。
     */
    expect(
      withDrill(`postgresql://postgres:${PW}@${PRODUCTION_REF}:5432/postgres`),
    ).toThrow(/本番のプロジェクト/);
  });

  it("使い捨ての別プロジェクトなら通す", () => {
    const url = `postgresql://postgres:${PW}@${SCRATCH_REF}:5432/postgres?sslmode=no-verify`;
    expect(withDrill(url)()).toBe(url);
  });

  it("Neon（dev / preview）を練習に使わせない", () => {
    /*
     * ★本番の写しを検証環境へ入れない。★ 利用者のメッセージ・
     * 暗号化済みメールアドレス・復号できるIPが、検証環境へ移ってしまう。
     */
    expect(
      withDrill(`postgresql://own:${PW}@ep-x-pooler.aws.neon.tech/nakadachi_dev`),
    ).toThrow(/Supabase を指していません/);
  });

  it("プーラーを指していたら拒む", () => {
    expect(
      withDrill(
        `postgresql://postgres.abc:${PW}@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`,
      ),
    ).toThrow();
    // db.<ref> の形でポートだけプーラー、というのも塞ぐ。
    expect(
      withDrill(`postgresql://postgres:${PW}@${SCRATCH_REF}:6543/postgres`),
    ).toThrow(/プーラー/);
  });

  it("未設定・ひな型のままなら止まる", () => {
    expect(() => requireConnectionString("drill")).toThrow(/未設定/);
    /*
     * ★山括弧で囲むのは意図的。★ check-secrets.mjs は、パスワード部に
     * < > を含むものを「手順書の穴埋め」として見逃す（実物の URL では
     * パーセント符号化される）。囲まないと REPLACE_ME は10文字なので
     * 本物らしい接続文字列として毎回止められ、この検査ファイル自体が
     * コミットできなくなる。requireConnectionString 側は includes で
     * 見ているので、囲んでも同じ分岐を通る。
     */
    expect(
      withDrill(`postgresql://postgres:<REPLACE_ME>@${SCRATCH_REF}:5432/postgres`),
    ).toThrow(/ひな型/);
  });
});

describe("本番（production）", () => {
  it("本番以外の Supabase プロジェクトを指していたら拒む", () => {
    process.env.DATABASE_URL_PRODUCTION = `postgresql://postgres:${PW}@${SCRATCH_REF}:5432/postgres`;
    expect(() => requireConnectionString("production")).toThrow(
      /想定と違う Supabase プロジェクト/,
    );
  });

  it("Neon を指していたら拒む（2026-08-18 に Supabase へ移行済み）", () => {
    process.env.DATABASE_URL_PRODUCTION = `postgresql://own:${PW}@ep-lucky-brook-x-pooler.aws.neon.tech/nakadachi`;
    expect(() => requireConnectionString("production")).toThrow(
      /Supabase.*を指していません/,
    );
  });

  it("正しい本番なら通す", () => {
    const url = `postgresql://postgres:${PW}@${PRODUCTION_REF}:5432/postgres?sslmode=no-verify`;
    process.env.DATABASE_URL_PRODUCTION = url;
    expect(requireConnectionString("production")).toBe(url);
  });
});

describe("preview / dev", () => {
  it("Supabase（本番系）を指していたら拒む", () => {
    process.env.DATABASE_URL_PREVIEW = `postgresql://postgres:${PW}@${PRODUCTION_REF}:5432/postgres`;
    expect(() => requireConnectionString("preview")).toThrow(/Neon のはず/);
  });

  it("データベース名が違えば拒む（貼り間違い）", () => {
    process.env.DATABASE_URL_PREVIEW = `postgresql://own:${PW}@ep-x-pooler.aws.neon.tech/nakadachi_dev`;
    expect(() => requireConnectionString("preview")).toThrow(
      /nakadachi_preview/,
    );
  });
});
