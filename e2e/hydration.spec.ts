import { expect, test } from "@playwright/test";

/**
 * ハイドレーションの見張り。
 *
 * ★このテストが無いと本番まで気づけない種類の壊れ方がある。★
 * CSP を nonce 方式にしているため、nonce が届かない・一致しないと
 * React のスクリプトが全部ブロックされる。すると
 *   - 画面は正常に出る（SSR 済みの HTML は配信される）
 *   - 文言もマークアップも正しい
 *   - curl では 200 が返る
 * のに、★ボタンとリンクだけが反応しない★という状態になる。
 *
 * 実ブラウザで「クリックして状態が変わる」ことを確かめる以外に
 * 検出する方法が無い。
 */

test.describe("ハイドレーション", () => {
  test("クライアント側のルーティングが動く（＝ハイドレーションが起きている）", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    let fullLoads = 0;
    page.on("load", () => {
      fullLoads += 1;
    });

    await page.goto("/legal/terms");
    await expect(
      page.getByRole("heading", { name: "利用規約", level: 1 }),
    ).toBeVisible();
    const loadsAfterFirstNavigation = fullLoads;

    // フッターのリンクを踏む。ハイドレーションが起きていれば、
    // ドキュメントを再読み込みせずに画面が切り替わる。
    await page
      .getByRole("link", { name: "プライバシーポリシー" })
      .first()
      .click();

    await expect(
      page.getByRole("heading", { name: "プライバシーポリシー", level: 1 }),
    ).toBeVisible();
    expect(page.url()).toContain("/legal/privacy");

    // ★ここが本体★ 全体再読み込みが増えていなければ、
    // クライアント側のルーターが動いている。
    expect(fullLoads).toBe(loadsAfterFirstNavigation);

    // React error #418（id の採番ずれ）などもここで捕まえる。
    expect(pageErrors).toEqual([]);
  });

  test("スクリプトが CSP に弾かれていない", async ({ page }) => {
    const blocked: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("Content Security Policy")) blocked.push(text);
    });

    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: "ログイン", level: 1 }),
    ).toBeVisible();

    expect(blocked).toEqual([]);
  });

  test("入力欄の id がサーバーとブラウザで一致している", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/contact");
    // ラベルから入力欄を引ける＝ for と id が対応している。
    // ★id をカウンターで採番していると、ここが SSR とブラウザでずれる。★
    await page.getByLabel("件名").fill("テスト");
    await expect(page.getByLabel("件名")).toHaveValue("テスト");

    expect(pageErrors).toEqual([]);
  });

  test("★自動生成の ID が画面に出ていない★", async ({ page }) => {
    await page.goto("/legal/prohibited");
    const text = await page.evaluate(() => document.body.innerText);
    // ULID がそのまま表示名として出ていないこと
    expect(text).not.toMatch(/\b[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}\b/);
  });
});

/**
 * ★Turnstile は「箱はあるが中身が空」で壊れる。★
 * 暗黙レンダリング（class="cf-turnstile"）だと、api.js が差し込んだ iframe を
 * React のハイドレーションが取り除いてしまう。画面には何も出ず、
 * コンソールにもエラーが出ない。curl でも HTML には箱があるので気づけない。
 *
 * 直リンクと画面遷移の両方を見る。暗黙レンダリングは
 * 「直リンクでは出るが、リンクを踏むと出ない」という形でも壊れる。
 */
test.describe("Turnstile の枠", () => {
  /*
   * ★iframe の有無で判定しない。★ 描かれ方は鍵と状況で変わる。
   * ローカルのテスト鍵では iframe を作らず、応答欄だけを差し込む。
   * サーバーが必要とするのは応答欄なので、そこを見るのが本質。
   */
  const responseField =
    "#cf-turnstile-container input[name='cf-turnstile-response']";

  test("直接開いたときに描画される", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator(responseField)).toBeAttached({ timeout: 15_000 });
  });

  test("★リンクから遷移しても描画される★", async ({ page }) => {
    // 暗黙レンダリングは api.js が読み込み時に1回描くだけなので、
    // 画面遷移で来たときに枠が出ない。直リンクだけを見ていると気づけない。
    await page.goto("/legal/terms");
    await page.getByRole("link", { name: "ログイン" }).first().click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator(responseField)).toBeAttached({ timeout: 15_000 });
  });
});
