import { expect, test } from "@playwright/test";

/**
 * 期待する環境を、接続先の URL から決める。
 *
 * ★/api/config には聞かない。★ あれは管理者しか読めない（2026-08-25 に閉じた）。
 * 「検査したい相手そのものに、期待値を教えてもらう」形もそもそも弱い。
 */
function expectedEnvironment(): "development" | "preview" | "production" {
  const base = process.env.E2E_BASE_URL ?? "http://localhost:5273";
  const host = new URL(base).hostname;
  if (host === "nakadachi.rewrite-co.com") return "production";
  if (host === "nakadachi-preview.rewrite-co.com") return "preview";
  return "development";
}

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

  test("★HTML は共有キャッシュに保存されない★", async ({ page }) => {
    /*
     * 無いと会社や ISP の中継が発見的な期限で保存してよいことになり、
     * 別の人のマイページが次の人に見える余地ができる。公開ページも
     * nonce と CSRF トークンが1回ごとに違うので private にしてある。
     */
    for (const path of ["/", "/legal/terms", "/login"]) {
      const response = await page.goto(path);
      expect(response!.headers()["cache-control"], path).toBe("private, no-store");
    }
  });

  test("★ハッシュ付きの静的アセットは1年 immutable★", async ({ request }) => {
    // 付けないと 186KB の JS も CSS も画面遷移のたびに再検証の往復が入る。
    const html = await (await request.get("/")).text();
    const scriptSrc = html.match(/["'](\/assets\/[^"']+\.js)["']/)?.[1];
    expect(scriptSrc, "HTML に /assets/*.js への参照があること").toBeTruthy();
    const asset = await request.get(scriptSrc!);
    expect(asset.status()).toBe(200);
    expect(asset.headers()["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    // 静的アセットは Worker を通らないので、_headers 側で nosniff を付けている。
    expect(asset.headers()["x-content-type-options"]).toBe("nosniff");
  });
});

test.describe("機械向けの口", () => {
  /**
   * ★期待する内容は環境で変わる。★
   * preview や開発環境は本番とほぼ同じ内容を別のホスト名で配るので、
   * 索引に入ると同じ投稿が2つの URL で並ぶ。本番以外は丸ごと拒否する。
   * E2E_BASE_URL を preview や本番へ向けても、そのまま正しく検査できるよう
   * 接続先のホスト名から期待値を切り替える（expectedEnvironment）。
   */
  test("robots.txt が環境に応じた内容で返る", async ({ request }) => {
    const response = await request.get("/robots.txt");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");

    const body = await response.text();

    if (expectedEnvironment() === "production") {
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
    const header = (await request.get("/")).headers()["x-robots-tag"];

    if (expectedEnvironment() === "production") {
      expect(header).toBeUndefined();
    } else {
      expect(header).toBe("noindex, nofollow");
    }
  });

  /*
   * ★/api/config は誰にでも見せない。★
   *
   * この検査は 2026-08-25 の公開前監査で**逆向きに書き直した**。
   * それまでは「誰でも叩けて中身が読める」ことを確かめていて、
   * この spec 自身が環境の判定に使っていた。
   *
   * 中身の secretsConfigured は「いま、どの守りが効いていないか」の一覧
   * そのもので、turnstile:false と読めばボット対策が外れている隙を
   * そのまま狙える。turnstileExpectedHosts は、1つの共有ウィジェットを
   * 全サービスで使い回している以上、他サービス向けのトークンを弾く
   * 唯一の材料でもある。
   */
  test("★/api/config は未ログインでは読めない★", async ({ request }) => {
    const response = await request.get("/api/config", {
      maxRedirects: 0,
      failOnStatusCode: false,
    });

    // 管理者以外には「そこに何かある」ことも見せない（404）。
    // 管理者ログイン済みで第3層が未通過なら /admin/gate へ送られる（3xx）。
    expect(response.status()).not.toBe(200);

    const body = await response.text();
    expect(body).not.toContain("secretsConfigured");
    expect(body).not.toContain("turnstileExpectedHosts");
  });

  /*
   * ボット対策が画面に繋がっていること。
   * 置き場所と、組み立てる側のコードの2つを見る。
   */
  test("★ログイン画面に Turnstile が組み込まれている★", async ({
    request,
  }) => {
    const html = await (await request.get("/login")).text();

    /*
     * ★スクリプトのタグは SSR の HTML には出ない。★ ウィジェットは
     * render=explicit で、api.js はハイドレーション後に JS が差し込む。
     * サーバーが返す HTML にあるのは、置き場所の div と鍵だけ。
     *
     * 置き場所の id は "turnstile" にしてはいけない。ブラウザが
     * window.turnstile をその div にしてしまい、api.js が初期化を諦める。
     */
    expect(html).toContain('id="cf-turnstile-container"');

    // ウィジェットを組み立てる側のコードが実際に読み込まれていること。
    expect(html).toMatch(/assets\/turnstile-[\w-]+\.js/);

    /*
     * ★サイトキーの «値» はここでは見ない。★
     *
     * ハイドレーションの本文は turbo-stream で、キーと値が別々の要素に
     * 分かれて並ぶ（`"turnstileSiteKey":"..."` という形にはならない）。
     * しかも本文はストリームなので、request.get() が受け取る最初の塊に
     * 入っているとは限らない。無理に照合すると、★実際には入っているのに
     * «見つからない» と言う検査★になり、直すために本物の穴を
     * 見落とすほうへ流れる。
     *
     * 配られている値そのものは、管理者として /api/config を見るのが
     * 正しい確かめ方（2026-08-25 にこの口を第3層の内側へ移した）。
     * 手順は OPERATIONS.md。
     */

    // 秘密の側が紛れていないこと
    expect(html).not.toContain("sk_");
    expect(html).not.toContain("whsec_");
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
  /*
   * ★DB が無い環境では、DB を触る経路の検査を飛ばす。★
   * CI にはデータベースが無い（アプリは Neon 専用ドライバを使っており、
   * 素の PostgreSQL とは話せないため、サービスコンテナでは代用できない）。
   * DB が無いと一覧・詳細・地域ページは 503 になり、404 の検査は必ず落ちる。
   *
   * ★黙って飛ばさない。★ 何を検査しなかったかを必ず出力する。
   * 飛ばした事実が見えないと「全部緑だから大丈夫」と読まれてしまう。
   */
  let hasDb = false;
  test.beforeAll(async ({ request }) => {
    try {
      const res = await request.get("/api/health");
      hasDb = res.ok() && ((await res.json()) as { db?: boolean }).db === true;
    } catch {
      hasDb = false;
    }
    if (!hasDb) {
      console.warn(
        "[E2E] データベースが無いため、DB を触る画面の検査を飛ばします。" +
          "（一覧・詳細・地域ページの 404 とトップの 200）",
      );
    }
  });

  /** DB が要らない経路。ルーターとガードだけで完結する */
  const missingWithoutDb = [
    "/zzz-such-page-does-not-exist",
    // 管理画面は「存在すら知らせない」ので 404（403 ではない）
    "/admin",
  ];

  /** DB を引いた結果として 404 になる経路 */
  const missingWithDb = [
    "/c/no-such-category",
    "/area/9999",
    "/listings/01JQZZZZZZZZZZZZZZZZZZZZZZ",
  ];

  for (const path of missingWithoutDb) {
    test(`${path} は 404 を返す`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);
      await expect(
        page.getByRole("heading", { name: "ページが見つかりません" }),
      ).toBeVisible();
    });
  }

  for (const path of missingWithDb) {
    test(`${path} は 404 を返す（DBが要る）`, async ({ page }) => {
      test.skip(!hasDb, "データベースが無い");
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);
      await expect(
        page.getByRole("heading", { name: "ページが見つかりません" }),
      ).toBeVisible();
    });
  }

  test("公開中のページは 200 のまま", async ({ page }) => {
    // 法務ページは DB を使わないので、DB の有無によらず必ず見る。
    for (const path of ["/legal/terms", "/legal/prohibited"]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
    }
    test.skip(!hasDb, "データベースが無い");
    for (const path of ["/", "/c/sell-buy", "/search?q=x"]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
    }
  });
});
