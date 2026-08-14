import type { NeonDatabase } from "drizzle-orm/neon-serverless";

import type * as schema from "./schema/index.ts";

/**
 * DB クライアントの型だけを持つモジュール。
 *
 * ★ここを `app/server/db.server.ts` から切り出しているのには理由がある。★
 * db.server.ts は `~/` 別名でインポートしている。この別名を解決できるのは
 * Vite だけで、`node --experimental-strip-types` で動かすスクリプト
 * （マイグレーション・seed・定期処理）からは読めない。型を借りるためだけに
 * db.server.ts を import すると、実行時に「Cannot find package '~'」で落ちる。
 *
 * このファイルは相対パスしか使わないので、Vite からも素の Node からも読める。
 */
export type DbSchema = typeof schema;
export type Db = NeonDatabase<DbSchema>;

/**
 * テストや Node のスクリプトから、既存の Drizzle インスタンスを
 * アプリと同じ型として扱うためのヘルパ。
 *
 * node-postgres 版（テスト・スクリプト）と neon-serverless 版（本番）は、
 * Drizzle の公開 API が同一で、リポジトリ層が使う機能に差が無い。型だけを合わせる。
 */
export function asDb(instance: unknown): Db {
  return instance as Db;
}
