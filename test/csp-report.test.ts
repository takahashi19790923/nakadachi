import { describe, expect, it, vi } from "vitest";

import { action } from "~/routes/api.csp-report";

/**
 * CSP 違反の受け口。
 *
 * ★誰でも叩ける口である前提の検査。★ 中身は攻撃者が自由に作れるので、
 *   - 大きな本文で読み込ませない
 *   - 文字列以外を渡されても壊れない・変な値を残さない
 *   - 何を受理したかを応答から測らせない（常に 204）
 * を確かめる。
 */

function ctx() {
  const warn = vi.fn();
  return {
    warn,
    context: {
      get: () => ({
        logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      }),
    },
  };
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:5273/api/csp-report", {
    method: "POST",
    headers: { "content-type": "application/csp-report", ...headers },
    body,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (request: Request, c: any) => action({ request, context: c } as any);

describe("CSP 違反の受け口", () => {
  it("正常な報告は、規則と «ホストだけ» を残す", async () => {
    const { warn, context } = ctx();
    const body = JSON.stringify({
      "csp-report": {
        "violated-directive": "script-src",
        "blocked-uri": "https://evil.example/steal.js?token=secret",
        "document-uri": "https://nakadachi.rewrite-co.com/listings/01ABC/edit",
      },
    });

    const res = await call(post(body), context);
    expect(res.status).toBe(204);

    expect(warn).toHaveBeenCalledTimes(1);
    const fields = warn.mock.calls[0]![1] as Record<string, string>;
    expect(fields.directive).toBe("script-src");
    // ★ホストだけ。★ クエリに乗った値をログへ持ち込まない。
    expect(fields.blocked).toBe("evil.example");
    expect(fields.blocked).not.toContain("secret");
    // ★閲覧履歴を残さない。★ どの投稿を見ていたかは残さない。
    expect(fields.where).toBe("/listings");
    expect(JSON.stringify(fields)).not.toContain("01ABC");
  });

  it("★大きな本文は読まずに捨てる★", async () => {
    const { warn, context } = ctx();
    const huge = "a".repeat(20 * 1024);
    const res = await call(
      post(JSON.stringify({ "csp-report": { "blocked-uri": huge } })),
      context,
    );
    expect(res.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it("★文字列以外を渡されても «[object Object]» を残さない★", async () => {
    const { warn, context } = ctx();
    const body = JSON.stringify({
      "csp-report": {
        "violated-directive": { evil: true },
        "blocked-uri": [1, 2, 3],
        "document-uri": 42,
      },
    });

    const res = await call(post(body), context);
    expect(res.status).toBe(204);

    const fields = warn.mock.calls[0]![1] as Record<string, string>;
    expect(JSON.stringify(fields)).not.toContain("object Object");
    expect(fields.directive).toBe("unknown");
  });

  it("壊れた本文でも落ちない（常に 204）", async () => {
    for (const body of ["", "{", "null", "[]", '{"csp-report":null}']) {
      const { context } = ctx();
      const res = await call(post(body), context);
      expect(res.status, body).toBe(204);
    }
  });

  it("★何を受理したかを応答で測らせない★", async () => {
    // 正常な報告も、壊れた報告も、同じ応答。
    const ok = await call(
      post(JSON.stringify({ "csp-report": { "violated-directive": "img-src" } })),
      ctx().context,
    );
    const broken = await call(post("{{{"), ctx().context);
    expect(ok.status).toBe(broken.status);
    expect(await ok.text()).toBe(await broken.text());
  });
});
