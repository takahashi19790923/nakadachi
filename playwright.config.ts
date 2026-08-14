import { defineConfig, devices } from "@playwright/test";

// E2E の対象。既定はローカルの dev サーバー。E2E_BASE_URL を渡すと
// preview / 本番に当たる（Turnstile が実鍵になるので挙動が変わる点に注意）。
const externalBaseUrl = process.env.E2E_BASE_URL;

// ★ポートはサービス専用の値にする。★ 既定値を使い回すと、別チャットが
// 動かしている別サービスの画面を相手にテストしてタイムアウトする。
const LOCAL_PORT = 5274;
// ★127.0.0.1 と書かない。★ Vite の dev サーバーは Windows で localhost を
// IPv6（::1）に解決して束縛することがあり、127.0.0.1 では接続できない。
// 「サーバーは動いているのに起動待ちでタイムアウトする」という形で失敗する。
const localBaseUrl = `http://localhost:${LOCAL_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: externalBaseUrl ?? localBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  },

  projects: [
    // モバイルファーストなので、まず携帯の幅で通ることを見る。
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],

  webServer: externalBaseUrl
    ? undefined
    : {
        // ★開発サーバーではなく本番ビルドに当てる。★
        // dev では Vite が HMR 用のインラインスクリプトを差し込むため、
        // CSP 違反が必ず出て「本番でも壊れている」のか区別できない。
        // 出荷するものを検査する。
        command: `node scripts/dev-setup.mjs && pnpm run build && pnpm exec vite preview --port ${LOCAL_PORT}`,
        // ★トップページで起動を判定しない。★ トップは投稿一覧を引くので
        // データベースへの接続が要る。DB を用意していない環境では 500 になり、
        // 「サーバーは動いているのに起動待ちでタイムアウトする」という
        // 紛らわしい失敗になる。DB を必要としないページで判定する。
        url: `${localBaseUrl}/legal/terms`,
        // ★true にしない。★ 前回の実行が残した「古いビルドのサーバー」を
        // 掴んで、直したはずの箇所が落ち続ける。立て直しは数秒で済むが、
        // 誤った結果を1回信じるほうがずっと高くつく。
        reuseExistingServer: false,
        timeout: 180_000,
        stdout: "pipe",
        stderr: "pipe",
      },
});
