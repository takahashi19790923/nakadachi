import { describe, expect, it } from "vitest";

import type { AppEnv } from "~/server/env.server";
import {
  AppError,
  asRouteError,
  ConfigurationError,
  rateLimited,
  routeErrorMessage,
} from "~/server/errors";
import {
  applySecurityHeaders,
  isSharedCacheable,
} from "~/server/security-headers.server";

/**
 * 応答の形（監査 AUTH-08・HDR-02・HDR-04・HDR-06）。
 */

const env = {
  APP_ORIGIN: "https://nakadachi.rewrite-co.com",
  ENVIRONMENT: "production",
} as AppEnv;

describe("asRouteError（AppError を伏せられない形にする）", () => {
  it("AppError は状態と利用者向けの文言だけを持つ «ルートのエラー応答» になる", () => {
    const converted = asRouteError(rateLimited("rate limit threadCreate exceeded (count=31)"));
    expect(converted).toMatchObject({
      type: "DataWithResponseInit",
      init: { status: 429 },
      data: { message: "操作が続けて行われました。しばらく時間をおいてからお試しください。" },
    });
    // ★detail（内部の事情）は載せない。★
    expect(JSON.stringify(converted)).not.toContain("threadCreate");
  });

  it("設定不備は 503、CSRF などの派生クラスも同じに扱う", () => {
    expect(asRouteError(new ConfigurationError("SESSION_SECRET missing"))).toMatchObject({
      init: { status: 503 },
    });
    expect(
      asRouteError(new AppError("csrf_mismatch", "画面を開き直してください")),
    ).toMatchObject({ init: { status: 403 }, data: { message: "画面を開き直してください" } });
  });

  it("Response とそれ以外の例外は、そのまま返す", () => {
    const response = new Response(null, { status: 404 });
    expect(asRouteError(response)).toBe(response);
    const bug = new TypeError("x is undefined");
    expect(asRouteError(bug)).toBe(bug);
  });
});

describe("Cache-Control を決めていない応答は private, no-store", () => {
  function cacheControlOf(response: Response): string | null {
    return applySecurityHeaders(response, env, "n").headers.get("cache-control");
  }

  it("HTML 以外も付く（.data・リダイレクト・JSON の 404）", () => {
    // 画面遷移で読む .data（中身はマイページやメッセージそのもの）
    expect(
      cacheControlOf(new Response("[]", { headers: { "content-type": "text/x-script" } })),
    ).toBe("private, no-store");
    // ログインへの 302（CSRF の Set-Cookie が付く）
    expect(
      cacheControlOf(new Response(null, { status: 302, headers: { location: "/login" } })),
    ).toBe("private, no-store");
    expect(
      cacheControlOf(
        new Response("{}", { status: 404, headers: { "content-type": "application/json" } }),
      ),
    ).toBe("private, no-store");
  });

  it("自分で決めた応答は触らない", () => {
    expect(
      cacheControlOf(new Response("ok", { headers: { "cache-control": "public, max-age=3600" } })),
    ).toBe("public, max-age=3600");
  });
});

describe("isSharedCacheable（Cookie を足してはいけない応答）", () => {
  function cacheable(cacheControl: string | null): boolean {
    const headers = new Headers();
    if (cacheControl !== null) headers.set("cache-control", cacheControl);
    return isSharedCacheable(headers);
  }

  it("public・s-maxage・private の無い max-age は共有キャッシュに置ける", () => {
    expect(cacheable("public, max-age=3600")).toBe(true);
    expect(cacheable("public, max-age=86400, stale-while-revalidate=604800")).toBe(true);
    expect(cacheable("max-age=60, s-maxage=600")).toBe(true);
    expect(cacheable("Public")).toBe(true);
    // RFC 9111 §3: private が無ければ max-age だけでも共有キャッシュは保存できる。
    expect(cacheable("max-age=60")).toBe(true);
  });

  it("private・no-store・指定なしは置けない", () => {
    expect(cacheable("private, no-store")).toBe(false);
    expect(cacheable("private, max-age=60")).toBe(false);
    expect(cacheable("no-store")).toBe(false);
    expect(cacheable("public, no-store")).toBe(false);
    expect(cacheable(null)).toBe(false);
    expect(cacheable("no-cache")).toBe(false);
  });
});

describe("routeErrorMessage（エラーの画面に出す文言）", () => {
  it("asRouteError が作った中身の文言は出す", () => {
    expect(routeErrorMessage({ message: "画面を開き直してください" })).toBe(
      "画面を開き直してください",
    );
  });

  it("★React Router 自身のエラー（data が Error）は出さない★", () => {
    // action の無い画面への POST（405）で React Router が入れる形。
    const internal = new Error(
      'You made a POST request to "/legal/terms" but did not provide an `action` for route "routes/legal.terms"',
    );
    expect(routeErrorMessage(internal)).toBeNull();
  });

  it("形が違うものは出さない", () => {
    expect(routeErrorMessage("Not Found")).toBeNull();
    expect(routeErrorMessage(null)).toBeNull();
    expect(routeErrorMessage({ message: "" })).toBeNull();
    expect(routeErrorMessage({ message: 1 })).toBeNull();
  });
});

describe("asRouteError は記録を残す", () => {
  it("logger を渡せば code と detail を warn で残す（detail は1行に）", () => {
    const lines: { message: string; fields?: Record<string, string | number> }[] = [];
    const logger = {
      warn: (message: string, fields?: Record<string, string | number>) => {
        lines.push({ message, fields });
      },
    };
    const LF = String.fromCharCode(10);
    asRouteError(new AppError("csrf_mismatch", "x", { detail: `origin mismatch${LF}forged` }), logger);
    expect(lines).toEqual([
      { message: "request rejected", fields: { code: "csrf_mismatch", detail: "origin mismatch forged" } },
    ]);
  });
});
