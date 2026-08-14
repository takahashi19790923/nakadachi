import { createContext } from "react";

/**
 * CSP の nonce を、ルートのレイアウトまで運ぶための React コンテキスト。
 *
 * ★ローダーのデータ経由にしないこと。★ root.tsx の Layout は
 * useRouteLoaderData("root") が undefined になる場面があり、そのとき nonce が
 * 空になる。すると <Scripts> に nonce が付かず、CSP がすべてのスクリプトを
 * 遮断する。結果は
 *   - 画面は正常に出る（SSR 済みの HTML は配信される）
 *   - curl では 200 が返る
 *   - ★ボタンとリンクだけが反応しない★
 * という、目視でも curl でも気づけない壊れ方になる。
 *
 * entry.server.tsx が値を入れ、Layout が読む。この経路なら
 * ローダーの成否に関係なく必ず届く。
 *
 * クライアント側では空文字のまま。既に DOM にあるスクリプトへ
 * nonce を付け直す必要は無い（React は nonce を再描画の比較から外す）。
 */
export const NonceContext = createContext<string>("");
