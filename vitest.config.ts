import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 単体テスト。DB もネットワークも触らない純粋なロジックだけを対象にする。
// ここが速く保たれていないと、開発中に誰も回さなくなる。
export default defineConfig({
  resolve: {
    alias: {
      // import.meta.url を自前で file:// から剥がすと、日本語フォルダ名が
      // %E3%83%89... のまま残って解決に失敗する。fileURLToPath を使う。
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "app/**/*.test.ts"],
    exclude: ["node_modules/**", "build/**", "test-integration/**", "e2e/**"],
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage/unit",
      include: ["app/domain/**", "app/server/**"],
    },
  },
});
