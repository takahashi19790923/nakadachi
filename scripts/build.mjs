import { spawn } from "node:child_process";

/**
 * 環境を指定してビルドする。
 *
 *   node scripts/build.mjs preview
 *   node scripts/build.mjs production
 *
 * ★CLOUDFLARE_ENV はビルド時にしか効かない。★
 * @cloudflare/vite-plugin は、ビルドの時点で wrangler.jsonc の環境を1つに
 * 畳んだ設定を出力する。デプロイ時に環境を指定しても効かない。
 *
 * ★シェルの環境変数の書き方に依存しない。★
 * `CLOUDFLARE_ENV=production vite build` は PowerShell では動かない。
 * 手順書に書いたコマンドが Windows でそのまま動かない、という事故を避ける。
 */

const target = process.argv[2];

if (target !== "preview" && target !== "production") {
  console.error("使い方: node scripts/build.mjs <preview|production>");
  process.exit(1);
}

const child = spawn("pnpm", ["exec", "react-router", "build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, CLOUDFLARE_ENV: target },
});

child.on("close", (code) => {
  process.exit(code ?? 1);
});
