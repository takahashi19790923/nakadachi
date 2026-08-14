import { sql } from "drizzle-orm";
import { timestamp, varchar } from "drizzle-orm/pg-core";

// drizzle-kit は tsconfig の paths を解決しないので相対パスで書く。
import { ULID_LENGTH } from "../../domain/ulid.ts";

/**
 * 主キーの型。ULID を Crockford base32 の26文字で持つ。
 *
 * 連番を使わない理由は IDOR 対策。URL の ID を1つずらして他人のデータへ
 * 到達できる作りを、まず ID の側で成立しにくくしておく（権限チェックは
 * 別途すべての API で行う。ID の推測困難性はそれの代わりにはならない）。
 */
export function ulidPk(name = "id") {
  return varchar(name, { length: ULID_LENGTH }).primaryKey();
}

/** 他テーブルの ULID を指す列 */
export function ulidRef(name: string) {
  return varchar(name, { length: ULID_LENGTH });
}

/**
 * 生成時刻・更新時刻。
 *
 * ★毎回新しいビルダーを作る関数にしてある。★ 列の定義を定数で共有して
 * 複数テーブルへ配ると、ビルダーの内部状態を共有してしまい、片方の設定が
 * もう片方へ漏れることがある。関数なら必ず独立した定義になる。
 *
 * 型は timestamptz。timestamp（タイムゾーン無し）にすると、Workers（UTC）と
 * 管理者の端末（JST）で同じ値が別の時刻に見え、掲載期限の判定がずれる。
 */
export function timestamps() {
  return {
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  };
}

/** 論理削除。物理削除は退会とクリーンアップの経路だけで行う */
export function softDelete() {
  return {
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  };
}
