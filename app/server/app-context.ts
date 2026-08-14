import { createContext, type RouterContextProvider } from "react-router";

import type { Db } from "./db.server.ts";
import type { AppEnv } from "./env.server.ts";
import type { Logger } from "./logger.server.ts";

/**
 * ローダー・アクションへ渡すリクエスト単位の値。
 *
 * React Router 8 では context が RouterContextProvider になり、
 * 「型を宣言だけして素のオブジェクトを渡す」やり方は型検査を通らない。
 * createContext で鍵を1つ作り、Worker の入口で値を入れて、
 * 各ルートは getApp(context) で取り出す。
 *
 * ★ここに置いた値だけがサーバー側の入口。★ 各ルートが env を直接読んだり、
 * DB クライアントを自分で作ったりしないための集約点でもある。
 */
export interface AppContext {
  readonly env: AppEnv;
  /** Workers の ExecutionContext。waitUntil に使う */
  readonly ctx: ExecutionContext;
  /**
   * DB クライアント。★リクエストごとに作られる。★
   * 呼ばれて初めて接続を張るので、DB を使わない画面では作られない。
   */
  readonly getDb: () => Db;
  readonly logger: Logger;
  /** CSP の nonce */
  readonly nonce: string;
  readonly requestId: string;
  /** フォームへ埋める CSRF トークン */
  readonly csrfToken: string;
}

export const appContext = createContext<AppContext>();

/** ローダー・アクションの先頭で1回だけ呼ぶ */
export function getApp(context: Readonly<RouterContextProvider>): AppContext {
  return context.get(appContext);
}
