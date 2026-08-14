import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 統合テスト。本物の PostgreSQL に本物のマイグレーションを流して検査する。
//
// ★SQLite で代用しない。★ enum・部分索引・GIN・生成列・引用符つき列名が
// どれも検証できず、「テストは通ったが本番で動かない」をそのまま作る。
// 既定では PGlite（PostgreSQL 17 の WASM ビルド）をその場で立てるので、
// Docker も Neon も要らない。TEST_DATABASE_URL を設定すればそちらを使う。
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test-integration/**/*.test.ts"],
    globalSetup: ["./test-integration/global-setup.ts"],
    // 全テーブルを TRUNCATE しながら進むので、ファイル間の並行実行はしない。
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage/integration",
    },
  },
});
