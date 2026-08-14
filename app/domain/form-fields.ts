/**
 * フォームの項目名。
 *
 * サーバー側（アクション）とクライアント側（部品）の両方が使う。
 * ★依存を持たない専用ファイルにしてある。★ 定数を1つ import しただけで
 * サーバー専用の依存がブラウザ側バンドルへ引き込まれるのを避けるため。
 */

/** CSRF トークンを載せる隠し項目の名前 */
export const CSRF_TOKEN_FIELD = "_csrf";

/** Turnstile がフォームへ差し込む項目の名前（Cloudflare が決めている） */
export const TURNSTILE_FIELD = "cf-turnstile-response";

/**
 * Turnstile ウィジェットを描く箱の id。
 *
 * ★"turnstile" という id を使わないこと。★ ブラウザは id を持つ要素を
 * 同名のグローバル変数として公開するため、window.turnstile が div になり、
 * api.js が「すでに読み込み済み」と誤認して初期化をやめる。
 * 鍵が正しくても認証が全滅し、curl では絶対に見つからない。
 */
export const TURNSTILE_CONTAINER_ID = "cf-turnstile-container";
