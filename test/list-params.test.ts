import { describe, expect, it } from "vitest";

import { buildPageHref, type ListFilters } from "~/domain/list-params";

/**
 * ページ送りの URL。
 *
 * ★絞り込みを1つでも落とすと、2ページ目が別の一覧になる。★
 * 見出しの件数は絞り込み後のままなので、画面を見ても気づけない。
 */
function filters(overrides: Partial<ListFilters>): ListFilters {
  return { sort: "newest", page: 1, ...overrides };
}

describe("buildPageHref", () => {
  it("★検索ページではカテゴリ・地域もクエリに残す★", () => {
    const href = buildPageHref(
      "/search",
      filters({ category: "job", pref: "13", city: "13101", q: "本" }),
      2,
    );
    const url = new URL(href, "https://example.test");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("category")).toBe("job");
    expect(url.searchParams.get("pref")).toBe("13");
    expect(url.searchParams.get("city")).toBe("13101");
    expect(url.searchParams.get("q")).toBe("本");
    expect(url.searchParams.get("page")).toBe("2");
  });

  it("パスで固定された条件はクエリに重ねない", () => {
    const href = buildPageHref(
      "/c/sell-buy",
      filters({ category: "sell-buy", pref: "13" }),
      3,
      ["category"],
    );
    const url = new URL(href, "https://example.test");
    expect(url.searchParams.has("category")).toBe(false);
    // 地域はパスに無いので残す。
    expect(url.searchParams.get("pref")).toBe("13");
    expect(url.searchParams.get("page")).toBe("3");
  });

  it("地域ページでは都道府県と市区町村を落とし、カテゴリは残す", () => {
    const href = buildPageHref(
      "/area/13/13101",
      filters({ category: "job", pref: "13", city: "13101" }),
      2,
      ["pref", "city"],
    );
    const url = new URL(href, "https://example.test");
    expect(url.searchParams.has("pref")).toBe(false);
    expect(url.searchParams.has("city")).toBe(false);
    expect(url.searchParams.get("category")).toBe("job");
  });

  it("1ページ目・既定の並びではクエリを付けない", () => {
    expect(buildPageHref("/c/job", filters({ category: "job" }), 1, ["category"])).toBe(
      "/c/job",
    );
  });

  it("並び順と価格の範囲も保つ", () => {
    const url = new URL(
      buildPageHref("/search", filters({ sort: "price_asc", min: 100, max: 5000 }), 2),
      "https://example.test",
    );
    expect(url.searchParams.get("sort")).toBe("price_asc");
    expect(url.searchParams.get("min")).toBe("100");
    expect(url.searchParams.get("max")).toBe("5000");
  });
});
