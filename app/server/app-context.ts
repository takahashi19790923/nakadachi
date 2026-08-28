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
  /** Workers の ExecutionContext。DB を触らない後処理にだけ使う */
  readonly ctx: ExecutionContext;
  /**
   * 応答を返したあとに続ける処理を預ける。
   *
   * ★DB を触る後処理は必ずこちらへ。★ `ctx.waitUntil` を直接使うと、
   * 同じく waitUntil で走る接続の後始末（dispose）と競合して、
   * ★DB が閉じたあとにクエリを投げることがある。★
   * ローカルでは再現せず、本番で時々失敗する形になる。
   * defer に預けたものが全部片づいてから接続を畳む。
   *
   * 失敗しても応答には影響しない。中で必ず捕まえること。
   */
  readonly defer: (promise: Promise<unknown>) => void;
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
  /**
   * 応答に Set-Cookie を足す。
   *
   * ★ローダーやアクションの戻り値では Cookie を足せない場面がある。★
   * セッションの期限延長は「どの画面でも、読んだついでに起きる」ので、
   * 画面ごとに Response を組み立て直す形にはできない。Worker が最後に
   * まとめて付ける。
   */
  readonly setCookie: (value: string) => void;
}

export const appContext = createContext<AppContext>();

/** ローダー・アクションの先頭で1回だけ呼ぶ */
export function getApp(context: Readonly<RouterContextProvider>): AppContext {
  return context.get(appContext);
}
