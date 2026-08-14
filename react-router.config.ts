import type { Config } from "@react-router/dev/config";

export default {
  // ★全ページを毎リクエスト描画する（プリレンダリングしない）。★
  //
  // CSP を nonce 方式にしているため。ビルド時に HTML を焼くと nonce が固定値に
  // なり、リクエストごとに変わるヘッダ側の nonce と一致しなくなる。結果として
  // React 自身のスクリプトが全部ブロックされ、「見た目は正常なのにボタンだけ
  // 反応しない」という、curl では絶対に検出できない壊れ方をする。
  // e2e/hydration.spec.ts がこれを見張っている。
  ssr: true,
} satisfies Config;
