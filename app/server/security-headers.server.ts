import { isSecureOrigin, type AppEnv } from "./env.server.ts";

/**
 * セキュリティヘッダー。
 *
 * ★_headers ファイルではなくここから配っている理由★
 *  - CSP に毎リクエスト変わる nonce を入れる必要がある
 *  - Cloudflare の _headers は1行 2,000 文字が上限で、育つと入らない
 *  - 同じヘッダー名が複数のルールに当たったときの挙動が当てにできない。
 *    2本出るとブラウザは両方の交差を取るので、片方の nonce が効かなくなる
 *
 * ★CSP に 'unsafe-inline' を script-src へ入れないこと。★
 * React Router はハイドレーション用のデータをインライン script で埋め込む。
 * これを通すために 'unsafe-inline' を足すと、注入されたスクリプトも同時に
 * 通ることになる。nonce で「自分が出したものだけ」を許可する。
 *
 * nonce 方式が成立するのは全ページをリクエストごとに描いているから
 * （react-router.config.ts の ssr: true・プリレンダリング無し）。
 * ビルド時に HTML を焼くページを足すと、そのページだけ nonce が一致せず
 * ★見た目は正常なのにボタンだけ反応しない★ 状態になる。
 */
export function buildContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    // Turnstile の api.js。cloudflareinsights のビーコンはここで遮断される
    // （Cloudflare がエッジで HTML に差し込むため、リポジトリを見ても気づけない）。
    `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com`,
    // style 属性を使うため 'unsafe-inline' が要る。スクリプトと違い、
    // スタイルの注入だけで任意コード実行にはならない。
    "style-src 'self' 'unsafe-inline'",
    // blob: は投稿フォームでのアップロード前プレビューに使う。
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    // 決済へ進むとき、フォーム送信の結果として checkout.stripe.com へ
    // 遷移する。ブラウザによっては転送先も form-action で見るため許可する。
    "form-action 'self' https://checkout.stripe.com",
    "object-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
    /*
     * ★止めた瞬間を観測できるようにする。★ これが無いと、注入の試みも
     * うっかり壊した設定も «静かに効く»。利用者からは「ボタンが反応しない」
     * としか見えず、報告も来ない（2026-08-25 の公開前監査で指摘）。
     *
     * 受け口は DB に書かない（api.csp-report.tsx）。荒らされたら
     * この1行を消せば止まる。アプリの動作には影響しない。
     */
    "report-uri /api/csp-report",
  ].join("; ");
}

export function applySecurityHeaders(
  response: Response,
  env: AppEnv,
  nonce: string,
): Response {
  const headers = new Headers(response.headers);

  headers.set("Content-Security-Policy", buildContentSecurityPolicy(nonce));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    // 実際に使わない機能はすべて空にする。
    // interest-cohort（FLoC）は廃止済みで無視される。後継の browsing-topics を閉じる。
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=(), browsing-topics=(), display-capture=(), fullscreen=(self)",
  );
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");

  if (isSecureOrigin(env)) {
    // preload は付けない。apex 全体への取り消しにくい約束になるため。
    headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }

  /*
   * ★本番以外は、すべての応答を索引拒否にする。★
   * robots.txt でも拒否しているが、あれは「お願い」で、従わないクローラーがいる。
   * ヘッダーなら画像・JSON・sitemap まで含めて効く。
   * ここを落とすと、preview が本番と同じ内容の別ホストとして索引に入り、
   * 投稿者の掲載が見覚えのないドメインで検索結果に出る。
   */
  if (env.ENVIRONMENT !== "production") {
    headers.set("X-Robots-Tag", "noindex, nofollow");
  }

  /*
   * ★HTML には必ず Cache-Control を付ける。★ 無いと共有キャッシュ
   * （会社や ISP の中継）が RFC 9111 の発見的な期限で保存してよいことになり、
   * ★別の人のマイページやメッセージが次の人に見える★余地ができる。
   * 2026-08-17 の点検まで、55 ある画面のどれも付けていなかった。
   *
   * 公開ページも private にする。同じ HTML でも CSP の nonce と CSRF の
   * トークンが1回ごとに違い、Set-Cookie も付く。共有キャッシュから配られた
   * 瞬間に「画面は出るがボタンが効かない」「最初の送信が CSRF で落ちる」になる。
   * ブラウザ自身の戻る／進むは no-store でも近年は動く（bfcache）。
   * 自分で Cache-Control を決めた応答（/media, sitemap, robots, API）は触らない。
   */
  const contentType = headers.get("content-type") ?? "";
  if (!headers.has("cache-control") && contentType.includes("text/html")) {
    headers.set("Cache-Control", "private, no-store");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** 1リクエストにつき1つ。推測できないことが CSP の前提 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
