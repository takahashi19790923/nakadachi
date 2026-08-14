import type { Route } from "./+types/catch-all";

/**
 * どのルートにも当たらなかったパス。
 *
 * ★必ず 404 を返す。★ SPA のフォールバックで全パスに 200 を返す作りにすると、
 * 存在しないURLがトップページとして配信され、検索エンジンに重複ページが
 * 大量に載る。監視も「200 が返っている＝正常」と誤判定する。
 */
export function loader(): never {
  // Response を throw すると React Router がエラー境界へ回す。
  throw new Response("Not Found", { status: 404 });
}

export function meta(): Route.MetaDescriptors {
  return [
    { title: "ページが見つかりません" },
    { name: "robots", content: "noindex, nofollow" },
  ];
}

export default function CatchAll() {
  return null;
}
