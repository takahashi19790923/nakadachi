import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// drizzle-kit は Node 側のツールなので .env を読む（アプリ本体は .dev.vars）。
// マイグレーションは DDL 権限のある「所有者ロール」で流す。アプリが実行時に
// 使うロールには DDL を与えない（SECURITY.md「DBロールの分離」）。
// `drizzle-kit generate` は DB へ接続しない（スナップショットの差分だけを見る）。
// 未設定でも生成できるように、接続を伴うコマンドでだけ効くダミーを置く。
// 実際に接続するコマンドはこの値では通らないので、設定漏れは必ず表面化する。
const url =
  process.env.DATABASE_URL ?? "postgresql://unset:unset@127.0.0.1:1/unset";

export default defineConfig({
  dialect: "postgresql",
  schema: "./app/db/schema/index.ts",
  out: "./app/db/migrations",
  dbCredentials: { url },
  casing: "snake_case",
  strict: true,
  verbose: true,
});
