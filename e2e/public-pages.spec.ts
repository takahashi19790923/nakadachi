import { expect, test } from "@playwright/test";

/**
 * DB を必要としない公開画面。
 *
 * 投稿の一覧・詳細・検索は Neon への接続が要るため、ここでは扱わない
 * （E2E_BASE_URL を preview 環境へ向けたときに e2e/flow.spec.ts が動く）。
 */

test.describe("規約とご案内", () => {
  const pages = [
    { path: "/legal/terms", heading: "利用規約" },
    { path: "/legal/privacy", heading: "プライバシーポリシー" },
    { path: "/legal/tokushoho", heading: "特定商取引法に基づく表記" },
    { path: "/legal/prohibited", heading: "禁止行為・禁止出品物" },
    { path: "/guide/safety", heading: "安全な取引のためのガイド" },
  ];

  for (const target of pages) {
    test(`${target.path} が表示される`, async ({ page }) => {
      await page.goto(target.path);
      await expect(
        page.getByRole("heading", { name: target.heading, level: 1 }),
      ).toBeVisible();
    });
  }

  test("★掲載料110円が明示されている★", async ({ page }) => {
    await page.goto("/legal/tokushoho");
    await expect(page.getByText("110円", { exact: false }).first()).toBeVisible();
    await expect(
      page.getByText("成約手数料、月額利用料、更新料はいただきません"),
    ).toBeVisible();
  });

  test("★運営者情報は外部の正本を参照している★（各サービスに複製しない）", async ({
    page,
  }) => {
    await page.goto("/legal/terms");
    const link = page.getByRole("link", { name: "運営者情報" }).first();
    await expect(link).toHaveAttribute(
      "href",
      "https://rewrite-co.com/legal/#operator",
    );
  });

  test("フッターに料金の説明がある", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByText("閲覧と会員登録は無料です。掲載時のみ1件"),
    ).toBeVisible();
  });
});

test.describe("セキュリティヘッダー", () => {
  test("必要なヘッダーがすべて付いている", async ({ page }) => {
    const response = await page.goto("/legal/terms");
    expect(response).not.toBeNull();
    const headers = response!.headers();

    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("geolocation=()");

    const csp = headers["content-security-policy"];
    expect(csp).toBeDefined();
    // ★script-src に 'unsafe-inline' が入っていないこと★
    const scriptSrc = csp!.split("; ").find((part) => part.startsWith("script-src"));
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9_-]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

test.describe("機械向けの口", () => {
  /**
   * ★期待する内容は環境で変わる。★
   * preview や開発環境は本番とほぼ同じ内容を別のホスト名で配るので、
   * 索引に入ると同じ投稿が2つの URL で並ぶ。本番以外は丸ごと拒否する。
   * E2E_BASE_URL を preview や本番へ向けても、そのまま正しく検査できるよう
   * /api/config が申告する環境で期待値を切り替える。
   */
  test("robots.txt が環境に応じた内容で返る", async ({ request }) => {
    const config = (await (await request.get("/api/config")).json()) as {
      environment: string;
    };

    const response = await request.get("/robots.txt");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");

    const body = await response.text();

    if (config.environment === "production") {
      expect(body).toContain("Disallow: /mypage");
      expect(body).toContain("Disallow: /admin");
      expect(body).toContain("Sitemap:");
    } else {
      // 丸ごと拒否。sitemap も出さない（拾わせる口を自分で開けない）
      expect(body).toContain("Disallow: /");
      expect(body).not.toContain("Allow: /");
      expect(body).not.toContain("Sitemap:");
    }
  });

  test("★本番以外は X-Robots-Tag で索引を拒否する★", async ({ request }) => {
    const config = (await (await request.get("/api/config")).json()) as {
      environment: string;
    };
    const header = (await request.get("/")).headers()["x-robots-tag"];

    if (config.environment === "production") {
      expect(header).toBeUndefined();
    } else {
      expect(header).toBe("noindex, nofollow");
    }
  });

  test("★/api/config が実際に配っているサイトキーを見せる★", async ({ request }) => {
    const response = await request.get("/api/config");
    expect(response.status()).toBe(200);

    const body = (await response.json()) as {
      turnstileSiteKey: string;
      secretsConfigured: Record<string, boolean>;
    };
    // 空なら、動いていてもボット対策は効いていない。
    expect(body.turnstileSiteKey).not.toBe("");
    // 値そのものは返していないこと
    expect(JSON.stringify(body)).not.toContain("sk_");
    expect(JSON.stringify(body)).not.toContain("whsec_");
    expect(typeof body.secretsConfigured.stripe).toBe("boolean");
  });
});

test.describe("404", () => {
  test("★存在しないパスに 200 を返さない★", async ({ request }) => {
    const response = await request.get("/this-path-does-not-exist");
    expect(response.status()).toBe(404);
  });

  test("エラー画面にスタックトレースを出さない", async ({ page }) => {
    await page.goto("/this-path-does-not-exist");
    const body = await page.textContent("body");
    expect(body).toContain("ページが見つかりません");
    // 内部のファイル構成が漏れていないこと
    expect(body).not.toContain("node_modules");
    expect(body).not.toContain(".server.ts");
    expect(body).not.toMatch(/\n\s+at\s+\S+\s+\(/);
  });
});

test.describe("ログイン画面", () => {
  test("パスワード欄が無い（パスワードレス）", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel("メールアドレス")).toBeVisible();
    expect(await page.locator('input[type="password"]').count()).toBe(0);
  });

  test("★CSRF トークンがフォームに入っている★", async ({ page }) => {
    await page.goto("/login");
    const token = await page.locator('input[name="_csrf"]').getAttribute("value");
    expect(token).toBeTruthy();
    expect(token).toContain(".");
  });

  test("★noindex になっている★", async ({ page }) => {
    await page.goto("/login");
    const robots = await page
      .locator('meta[name="robots"]')
      .getAttribute("content");
    expect(robots).toBe("noindex, nofollow");
  });
});

test.describe("アクセシビリティの土台", () => {
  test("本文へ移動のリンクがある", async ({ page }) => {
    await page.goto("/legal/terms");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "本文へ移動" })).toBeFocused();
  });

  test("言語が日本語として宣言されている", async ({ page }) => {
    await page.goto("/legal/terms");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  });

  test("モバイル幅で横スクロールが出ない", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/legal/prohibited");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow).toBe(false);
  });
});

/**
 * ★HTTP のステータスは、画面の見た目では確かめられない。★
 * 「ページが見つかりません」と出ていても、実際には 500 を返していた——
 * という状態が実際にあった。検索エンジンは本文ではなく番号を見るので、
 * 500 のままだと消したはずの URL が索引に残り続ける。
 * 見た目ではなく応答そのものを見張る。
 */
test.describe("見つからないときの応答", () => {
  const missing = [
    "/zzz-such-page-does-not-exist",
    "/c/no-such-category",
    "/area/9999",
    "/listings/01JQZZZZZZZZZZZZZZZZZZZZZZ",
    // 管理画面は「存在すら知らせない」ので 404（403 ではない）
    "/admin",
  ];

  for (const path of missing) {
    test(`${path} は 404 を返す`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);
      await expect(
        page.getByRole("heading", { name: "ページが見つかりません" }),
      ).toBeVisible();
    });
  }

  test("公開中のページは 200 のまま", async ({ page }) => {
    for (const path of ["/", "/c/sell-buy", "/legal/terms", "/search?q=x"]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
    }
  });
});
