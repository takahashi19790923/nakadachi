/**
 * サービス名・URL・連絡先の唯一の置き場所。
 *
 * ブランド名は仮称。変えるときはここだけを直す（画面やメール文面に直書きしない）。
 * このファイルはクライアントにも入るので、秘密情報を絶対に置かないこと。
 */
export const SITE = {
  /** Cloudflare のプロジェクト名・R2 のキー接頭辞などに使う識別子 */
  id: "nakadachi",
  /** 画面に出す名前（日本語） */
  name: "なかだち",
  /** ラテン文字表記。OGP の site_name やメールの差出人名に使う */
  nameLatin: "NAKADACHI",
  tagline: "地域で、ゆずる・かす・たのむ。",
  description:
    "住んでいる地域を選んで、ものの売り買い・ゆずりあい・貸し借り・手伝い・お仕事を掲載できます。閲覧と会員登録は無料です。",

  /** 本番の正規オリジン。実行時は env.APP_ORIGIN を優先すること */
  canonicalOrigin: "https://nakadachi.rewrite-co.com",

  /** 問い合わせ先。全サービス共通で、サービス独自のアドレスを作らない */
  supportEmail: "support@rewrite-co.com",

  /**
   * 運営者情報の参照先。
   *
   * ★運営者名・住所・電話番号をこのリポジトリに書かないこと。★
   * 複数サービスに同じ情報を持たせると、住所を変えたときにどれかが必ず古くなる。
   * 正本は rewrite-co.com/legal/ にあり、こちらからは絶対URLで参照するだけにする。
   */
  legal: {
    operatorUrl: "https://rewrite-co.com/legal/#operator",
    cookiesUrl: "https://rewrite-co.com/legal/#cookies",
  },
} as const;

/** OGP・構造化データで使う既定の共有画像（public/ に置く） */
export const DEFAULT_OG_IMAGE_PATH = "/og-default.png";
