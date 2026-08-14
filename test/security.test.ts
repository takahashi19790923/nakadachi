import { describe, expect, it } from "vitest";

import { buildPageMeta, privatePageMeta, stripContactInfo } from "~/domain/seo";
import { assertSameOrigin, isStateChanging } from "~/server/csrf.server";
import type { AppEnv } from "~/server/env.server";
import {
  applySecurityHeaders,
  buildContentSecurityPolicy,
} from "~/server/security-headers.server";
import { escapeHtml } from "~/server/services/email/templates.server";
import { normalizeForMatching } from "~/server/repositories/moderation-repository.server";

const env = {
  APP_ORIGIN: "https://nakadachi.rewrite-co.com",
  ENVIRONMENT: "production",
} as AppEnv;

function request(method: string, headers: Record<string, string> = {}): Request {
  return new Request("https://nakadachi.rewrite-co.com/listings/new", {
    method,
    headers,
  });
}

describe("CSRF：Origin の照合", () => {
  it("GET は対象外", () => {
    expect(isStateChanging(request("GET"))).toBe(false);
    expect(() => assertSameOrigin(request("GET"), env)).not.toThrow();
  });

  it("自分のオリジンからの POST は通す", () => {
    expect(() =>
      assertSameOrigin(
        request("POST", { origin: "https://nakadachi.rewrite-co.com" }),
        env,
      ),
    ).not.toThrow();
  });

  it("★別オリジンからの POST を拒否する★", () => {
    expect(() =>
      assertSameOrigin(request("POST", { origin: "https://evil.example" }), env),
    ).toThrow();
  });

  it("★前方一致で騙せない★", () => {
    expect(() =>
      assertSameOrigin(
        request("POST", { origin: "https://nakadachi.rewrite-co.com.evil.example" }),
        env,
      ),
    ).toThrow();
    expect(() =>
      assertSameOrigin(
        request("POST", { origin: "https://evil.example/nakadachi.rewrite-co.com" }),
        env,
      ),
    ).toThrow();
  });

  it("Origin が無ければ Referer で代替する", () => {
    expect(() =>
      assertSameOrigin(
        request("POST", { referer: "https://nakadachi.rewrite-co.com/listings/new" }),
        env,
      ),
    ).not.toThrow();
    expect(() =>
      assertSameOrigin(request("POST", { referer: "https://evil.example/x" }), env),
    ).toThrow();
  });

  it("★どちらも無ければ拒否する（fail-close）★", () => {
    expect(() => assertSameOrigin(request("POST"), env)).toThrow();
  });
});

describe("Content-Security-Policy", () => {
  const csp = buildContentSecurityPolicy("test-nonce-123");

  it("★script-src に 'unsafe-inline' を入れない★", () => {
    const scriptSrc = csp
      .split("; ")
      .find((part) => part.startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).toContain("'nonce-test-nonce-123'");
  });

  it("Turnstile だけを外部スクリプトとして許可する", () => {
    expect(csp).toContain("https://challenges.cloudflare.com");
    // 解析ビーコンの宛先が通っていないこと
    expect(csp).not.toContain("cloudflareinsights");
    expect(csp).toContain("connect-src 'self'");
  });

  it("フレーム埋め込みと base の乗っ取りを塞ぐ", () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  it("フォームの送信先を自分と決済事業者に限る", () => {
    expect(csp).toContain("form-action 'self' https://checkout.stripe.com");
  });
});

describe("SEO", () => {
  it("公開ページは既定で索引される", () => {
    const meta = buildPageMeta({
      title: "テスト",
      description: "説明",
      path: "/listings/abc",
      origin: "https://nakadachi.rewrite-co.com",
    });
    expect(meta.some((m) => "name" in m && m.name === "robots")).toBe(false);
    expect(
      meta.some(
        (m) =>
          "rel" in m &&
          m.rel === "canonical" &&
          m.href === "https://nakadachi.rewrite-co.com/listings/abc",
      ),
    ).toBe(true);
  });

  it("★マイページ・管理画面は必ず noindex★", () => {
    const meta = privatePageMeta("マイページ");
    expect(
      meta.some(
        (m) => "name" in m && m.name === "robots" && m.content === "noindex, nofollow",
      ),
    ).toBe(true);
  });

  it("noindex を明示すれば公開ページでも外せる", () => {
    const meta = buildPageMeta({
      title: "検索結果",
      description: "説明",
      path: "/search",
      noindex: true,
    });
    expect(meta.some((m) => "name" in m && m.name === "robots")).toBe(true);
  });

  it("★OGP の説明文から連絡先を落とす★", () => {
    expect(stripContactInfo("連絡は090-1234-5678まで")).not.toContain("090");
    expect(stripContactInfo("foo@example.com へどうぞ")).not.toContain(
      "foo@example.com",
    );
  });
});

describe("メール文面のエスケープ", () => {
  it("★投稿タイトルの HTML を無害化する★", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(escapeHtml("A & B")).toBe("A &amp; B");
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });
});

describe("禁止ワードの正規化", () => {
  it("★全角・記号・空白を寄せる（伏せ字を素通りさせない）★", () => {
    expect(normalizeForMatching("口 座 売 り ま す")).toBe("口座売ります");
    expect(normalizeForMatching("口・座・売・り・ま・す")).toBe("口座売ります");
    expect(normalizeForMatching("ＨＡＮＤＷＯＲＫ")).toBe("handwork");
    expect(normalizeForMatching("hand-work")).toBe("handwork");
  });
});

/**
 * ★preview を検索エンジンに拾わせない。★
 * preview は本番とほぼ同じ内容を別のホスト名で配る。索引に入ると、
 * 同じ投稿が2つの URL で並び、投稿者から見れば見覚えのないドメインに
 * 自分の掲載が載っている状態になる。robots.txt は従わないクローラーがいるので
 * ヘッダーでも拒否する。両方が要る。
 */
describe("本番以外は索引拒否", () => {
  function headersFor(environment: string): Headers {
    const response = applySecurityHeaders(
      new Response("ok"),
      { ...env, ENVIRONMENT: environment } as AppEnv,
      "test-nonce",
    );
    return response.headers;
  }

  it("preview には X-Robots-Tag が付く", () => {
    expect(headersFor("preview").get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("development にも付く", () => {
    expect(headersFor("development").get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("★本番には付かない（付くと本番が索引から消える）★", () => {
    expect(headersFor("production").get("x-robots-tag")).toBeNull();
  });

  it("環境によらずセキュリティヘッダは付く", () => {
    for (const e of ["production", "preview", "development"]) {
      const h = headersFor(e);
      expect(h.get("x-frame-options"), e).toBe("DENY");
      expect(h.get("x-content-type-options"), e).toBe("nosniff");
      expect(h.get("content-security-policy"), e).toContain("'nonce-test-nonce'");
    }
  });
});
