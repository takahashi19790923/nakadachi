import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * プライバシーポリシーの委託先一覧と、実際に接続している先の突き合わせ。
 *
 * ★書いてあることと、していることを機械で照合する。★
 *
 * 2026-08-18 に本番のデータベースを Neon（シンガポール）から
 * Supabase（東京）へ移したとき、ポリシーの更新が漏れた。結果として
 * ★実際に全個人情報を預けている事業者が公表されておらず、預けていない
 * 事業者が公表されている★状態が1週間続いた（2026-08-25 の公開前監査で発覚）。
 *
 * 人間の注意力ではなく、この検査で止める。委託先を増やすとき・変えるときは、
 * 下の対応表とポリシー本文の両方を直さないと落ちる。
 *
 * ★この検査の限界★
 * ソースに現れる https:// の宛先しか見ていない。Cloudflare（Workers・R2・
 * Hyperdrive）や Supabase のように、binding 経由で接続する先は URL として
 * 現れないので、対応表に「コードに出てこないが預けている先」として
 * 明示的に書いてある。そちらは目で確かめるほかない。
 */

const ROOT = join(import.meta.dirname, "..");
const PRIVACY = join(ROOT, "app/routes/legal.privacy.tsx");

/** 外部の宛先 → ポリシーに載っていなければならない事業者名 */
const HOST_TO_PROCESSOR: ReadonlyArray<readonly [string, string]> = [
  ["api.resend.com", "Resend"],
  ["api.stripe.com", "Stripe, Inc."],
  ["checkout.stripe.com", "Stripe, Inc."],
  ["challenges.cloudflare.com", "Cloudflare, Inc."],
];

/**
 * URL としてコードに現れないが、情報を預けている先。
 * binding（R2・Hyperdrive・Workers 自身）や接続文字列で繋がる。
 */
const BINDING_PROCESSORS = ["Cloudflare, Inc.", "Supabase, Inc."] as const;

/** 検査の対象外にする宛先（自サイト、標準の語彙、テスト用の偽物） */
const IGNORED = [
  "rewrite-co.com",
  "schema.org",
  "httpwg.org",
  "evil.example",
  "redirect-check.invalid",
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

function externalHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const dir of ["app", "workers"]) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/g)) {
        const host = match[1]!;
        if (IGNORED.some((skip) => host.endsWith(skip))) continue;
        hosts.add(host);
      }
    }
  }
  return hosts;
}

/**
 * 画面に出る本文だけを取り出す。
 *
 * ★コメントを含めたまま照合しない。★ 「Neon から Supabase へ移した」と
 * 経緯を書いたコメントが、そのまま「Neon が委託先として載っている」と
 * 読まれてしまう。読者が見るのは描画されたものだけ。
 */
function renderedText(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("プライバシーポリシーの委託先", () => {
  const policy = renderedText(readFileSync(PRIVACY, "utf8"));

  it("コードが接続している外部の宛先は、すべて対応表に載っている", () => {
    const known = new Set(HOST_TO_PROCESSOR.map(([host]) => host));
    const unknown = [...externalHosts()].filter((host) => !known.has(host));

    /*
     * ここが落ちたときは、新しい外部サービスを足したということ。
     * HOST_TO_PROCESSOR に追記し、★ポリシー本文にも事業者を足す★。
     * 端末から直接叩く先なら「外部送信」の表にも足す（電気通信事業法27条の12）。
     */
    expect(unknown, `対応表に無い外部の宛先: ${unknown.join(", ")}`).toEqual([]);
  });

  it("接続している事業者の名前が、ポリシー本文に書かれている", () => {
    const required = new Set([
      ...HOST_TO_PROCESSOR.map(([, name]) => name),
      ...BINDING_PROCESSORS,
    ]);
    const missing = [...required].filter((name) => !policy.includes(name));

    expect(missing, `ポリシーに載っていない委託先: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("預けていない事業者の名前が残っていない", () => {
    /*
     * 移行して使わなくなった先を消し忘れると、開示請求に対して
     * 嘘の一覧を出すことになる。preview では Neon を使い続けているが、
     * ポリシーは本番の話をしているので、本番で使っていない名前は出さない。
     */
    expect(policy).not.toContain("Neon");
  });

  it("外部送信（電気通信事業法27条の12）の公表が本文にある", () => {
    expect(policy).toContain("電気通信事業法第27条の12");
    // 端末から直接読み込む唯一の第三者スクリプト。
    expect(policy).toContain("Turnstile");
  });

  it("越境移転の相手国が名指しされている", () => {
    expect(policy).toContain("アメリカ合衆国");
  });

  it("バックアップに残る期間が書かれている", () => {
    // backup-service.server.ts の KEEP_GENERATIONS と合わせる。
    expect(policy).toContain("14日");
  });
});
