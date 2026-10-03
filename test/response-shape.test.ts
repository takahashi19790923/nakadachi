import { describe, expect, it } from "vitest";

import type { AppEnv } from "~/server/env.server";
import { AppError, asRouteError, ConfigurationError, rateLimited } from "~/server/errors";
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

  it("public・s-maxage は共有キャッシュに置ける", () => {
    expect(cacheable("public, max-age=3600")).toBe(true);
    expect(cacheable("public, max-age=86400, stale-while-revalidate=604800")).toBe(true);
    expect(cacheable("max-age=60, s-maxage=600")).toBe(true);
    expect(cacheable("Public")).toBe(true);
  });

  it("private・no-store・指定なしは置けない", () => {
    expect(cacheable("private, no-store")).toBe(false);
    expect(cacheable("no-store")).toBe(false);
    expect(cacheable("public, no-store")).toBe(false);
    expect(cacheable(null)).toBe(false);
    expect(cacheable("max-age=60")).toBe(false);
  });
});
