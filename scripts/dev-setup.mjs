import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

/**
 * ローカル開発と E2E のための .dev.vars を用意する。
 *
 *   node scripts/dev-setup.mjs
 *
 * ★既にある .dev.vars を絶対に上書きしない。★ 本物の鍵を入れて動かして
 * いる環境で実行されても壊さないため。
 *
 * ★アプリのコードを dev と本番で分岐させないための仕組み。★
 * 「鍵が無ければ検査を飛ばす」と書けば動くようにはなるが、それは
 * fail-open であり、本番で投入漏れに気づけなくなる。ローカルでは
 * ダミーの鍵を用意して、本番と同じ経路を通す。
 *
 * DATABASE_URL は書かない。ローカルで DB を使う画面を触るときは、
 * Neon の開発用ブランチの接続文字列を自分で追記する（README 参照）。
 */

const TARGET = ".dev.vars";

if (existsSync(TARGET)) {
  console.log(`${TARGET} は既にあります。変更しません。`);
  process.exit(0);
}

const key32 = () => randomBytes(32).toString("base64url");

const contents = `# scripts/dev-setup.mjs が自動生成したローカル用の値。
# ★本番の値ではありません。★ このファイルは .gitignore 済みです。
#
# データベースを使う画面（トップ・一覧・詳細・マイページ）を触るときは、
# Neon の開発用ブランチの接続文字列をここに追記してください。
# DATABASE_URL="postgresql://..."

SESSION_SECRET="${randomBytes(48).toString("base64url")}"
EMAIL_ENCRYPTION_KEY="${key32()}"
EMAIL_INDEX_KEY="${key32()}"

# 発信者情報(IP)の暗号化鍵。★上の2つとは別の値にする。★
# 1つ漏れたときに「誰がどこから」まで一緒に漏れるのを避けるため。
ACCESS_LOG_KEY="${key32()}"

# Cloudflare が公開しているテスト用の鍵（常に成功する）。
# ★サイトキーとシークレットは必ず対で使う。★ 片方だけ本番の共有鍵にすると
# siteverify が常に失敗し、画面には「確認に失敗しました」としか出ない。
# 共有ウィジェットのホスト名に localhost は入っていないので、
# 本番のサイトキーはローカルでは 110200 になり枠自体が描かれない。
TURNSTILE_SITE_KEY="1x00000000000000000000AA"
TURNSTILE_SECRET_KEY="1x0000000000000000000000000000000AA"

# Stripe と Resend はローカルでは未設定のままにする。
# 決済は開始できず、メールは送られずログに出るだけになる。

ADMIN_BASIC_AUTH_USER="local-admin"
ADMIN_BASIC_AUTH_PASS="${randomBytes(16).toString("base64url")}"
`;

writeFileSync(TARGET, contents, "utf8");
console.log(`${TARGET} を作成しました（ローカル専用のダミー値）。`);
