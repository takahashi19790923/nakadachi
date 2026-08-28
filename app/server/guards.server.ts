import { redirect } from "react-router";

import type { AppContext } from "./app-context.ts";

import { hasValidGate } from "./admin-gate.server.ts";
import { forbidden, notFound } from "./errors.ts";
import { getSessionUser, type SessionUser } from "./session.server.ts";

/**
 * 権限判定。
 *
 * ★UI の出し分けだけで守らない。★ すべてのローダーとアクションで、
 * このファイルの関数を通してから処理を始める。画面にボタンが無いことは
 * 「その API を呼べない」ことの証明にならない。
 */

export interface GuardArgs {
  request: Request;
  context: AppContext;
}

/**
 * 同じリクエスト内でセッションを何度も引かないための記憶。
 * 1画面で複数のローダーが動くため、素直に書くと同じ問い合わせが並ぶ。
 *
 * ★キーは AppContext（Worker が1リクエストにつき1つ作る）。★ 以前は Request を
 * キーにしていたが、React Router はフォーム送信のあとの再読み込みで
 * ★新しい Request オブジェクトを作る★ため、action で引いたセッションが
 * 直後のローダーで使い回されず、★すべての POST でセッションを2回引いていた★
 * （2026-08-17 の点検で発覚。約20の送信経路すべてに1往復ずつ乗っていた）。
 * AppContext は action と再読み込みのローダーに同じものが渡る。
 *
 * ★前提: 自分のセッションを失効・入れ替える action は redirect で終える。★
 * データを返して再読み込みさせると、ローダーが古い利用者を見る。
 * logout / login.verify / login.link はいずれも redirect で終えている。
 */
const userByContext = new WeakMap<AppContext, Promise<SessionUser | null>>();

export function loadUser({
  request,
  context,
}: GuardArgs): Promise<SessionUser | null> {
  const cached = userByContext.get(context);
  if (cached) return cached;

  // getDb は「関数のまま」渡す。Cookie が無ければ DB 接続は作られない。
  const promise = getSessionUser({
    getDb: context.getDb,
    env: context.env,
    request,
    /*
     * ★使われたら期限を延ばす配線。★ ここを渡さないと延長が効かない
     * （型が必須にしてあるので、渡し忘れはコンパイルで止まる）。
     * DB 更新は応答後（defer）、Cookie は Worker が最後に足す。
     */
    renew: { setCookie: context.setCookie, defer: context.defer },
  });
  userByContext.set(context, promise);
  return promise;
}

/** ログイン必須。未ログインなら、戻り先を付けてログイン画面へ送る */
export async function requireUser(args: GuardArgs): Promise<SessionUser> {
  const user = await loadUser(args);
  if (user) return user;

  const url = new URL(args.request.url);
  // ★戻り先はパスだけを引き継ぐ。★ 外部URLをそのまま入れると
  // オープンリダイレクトになる。
  const next = `${url.pathname}${url.search}`;
  throw redirect(`/login?next=${encodeURIComponent(next)}`);
}

/**
 * 管理者必須。
 *
 * ★権限が無い場合は 404 を返す。★ 403 だと「そのURLに管理画面がある」ことが
 * 分かる。管理画面の所在を当て推量で探させない。
 */
export async function requireAdmin(args: GuardArgs): Promise<SessionUser> {
  const user = await loadUser(args);
  if (!user || user.role !== "admin") {
    throw notFound("admin route accessed without admin role");
  }
  return user;
}

/**
 * 管理者かつ第3層を通過済み。
 * 管理データに触るローダー・アクションはすべてこちらを使う。
 */
export async function requireAdminGate(args: GuardArgs): Promise<SessionUser> {
  const user = await requireAdmin(args);
  const passed = await hasValidGate(args.request, args.context.env);
  if (!passed) {
    const url = new URL(args.request.url);
    throw redirect(
      `/admin/gate?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
    );
  }
  return user;
}

/**
 * 所有者であることの確認。
 *
 * ★見つからない扱いにするか、権限エラーにするかを意図して選ぶ。★
 * 他人の下書き・他人の会話は 404。存在の有無まで隠す。
 * 「自分のものだが操作が許されない」（停止中のアカウントなど）は 403。
 *
 * ★管理者を「所有者」として通さない。★
 *
 * 以前はここに `if (user.role === "admin") return;` があった。呼び出し元は
 * すべて /listings/* の利用者向け画面で、第1層（メールログイン）しか通って
 * いない。つまり ★管理者のメールボックスさえ取れば、第2層（管理者用の
 * 再認証）も第3層（共通の資格情報）も通らずに、他人の下書き・写真を読み、
 * 他人の掲載を書き換え・終了できた。★ しかも admin_actions に何も残らない
 * ので、あとから誰が触ったか分からない（2026-08-19 の公開前監査で発覚）。
 *
 * 管理者が他人のものを触る経路は /admin/* に集約してある。あちらは
 * requireAdminGate（3層すべて）を通り、理由の入力を必須にして
 * writeAdminAction で記録する。管理操作をそちらへ寄せることが目的。
 */
export function assertOwner(
  ownerId: string,
  user: SessionUser,
  options: { reveal?: boolean } = {},
): void {
  if (ownerId === user.id) return;
  throw options.reveal
    ? forbidden(`not owner: ${ownerId}`)
    : notFound(`not owner: ${ownerId}`);
}
