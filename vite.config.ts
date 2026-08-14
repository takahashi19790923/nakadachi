import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // ★ポートはサービスごとに変える。★
    // このアカウントでは複数のチャットが同時に開発サーバーを立てる。既定値を
    // 使い回すと、別サービスの画面を相手に E2E がタイムアウトする（実際に起きた）。
    port: 5273,
    strictPort: true,
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
