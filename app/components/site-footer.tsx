import { Link } from "react-router";

import { SITE } from "~/config/site";
import { LISTING_FEE_JPY, formatJpy } from "~/domain/pricing";

/**
 * フッター。
 *
 * ★運営者情報（氏名・住所・連絡先）をここに書かない。★
 * 正本は rewrite-co.com/legal/ にあり、絶対URLで参照するだけにする。
 * 各サービスに複製すると、住所を変えたときにどれかが必ず古くなる。
 * 別ホストなので相対リンクにしないこと。
 */
export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-washi-200 bg-white">
      <div className="mx-auto w-full max-w-5xl px-4 py-8 text-sm">
        <p className="font-semibold text-washi-800">
          {SITE.name}（{SITE.nameLatin}）
        </p>
        <p className="mt-1 text-washi-600">{SITE.description}</p>
        <p className="mt-3 rounded-lg bg-washi-100 px-3 py-2 text-washi-700">
          閲覧と会員登録は無料です。掲載時のみ1件あたり
          <strong className="mx-1 font-bold">{formatJpy(LISTING_FEE_JPY)}</strong>
          （税込）をいただきます。これ以外の手数料・成約料はいただきません。
        </p>

        <nav aria-label="規約とご案内" className="mt-6">
          <ul className="flex flex-wrap gap-x-4 gap-y-2">
            <li>
              {/* 運営者情報は1回だけ。項目の横に並べない */}
              <a
                className="link"
                href={SITE.legal.operatorUrl}
                rel="noopener noreferrer"
              >
                運営者情報
              </a>
            </li>
            <li>
              <Link className="link" to="/legal/terms">
                利用規約
              </Link>
            </li>
            <li>
              <Link className="link" to="/legal/privacy">
                プライバシーポリシー
              </Link>
            </li>
            <li>
              <a
                className="link"
                href={SITE.legal.cookiesUrl}
                rel="noopener noreferrer"
              >
                Cookieポリシー
              </a>
            </li>
            <li>
              <Link className="link" to="/legal/tokushoho">
                特定商取引法に基づく表記
              </Link>
            </li>
            <li>
              <Link className="link" to="/legal/prohibited">
                禁止行為・禁止出品物
              </Link>
            </li>
            <li>
              <Link className="link" to="/guide/safety">
                安全な取引のためのガイド
              </Link>
            </li>
            <li>
              <Link className="link" to="/contact">
                お問い合わせ
              </Link>
            </li>
          </ul>
        </nav>

        <p className="mt-6 text-xs text-washi-500">
          当サービスは利用者どうしの取引の場を提供するもので、取引の当事者には
          なりません。取引の内容・品質・履行について責任を負いかねます。
        </p>
      </div>
    </footer>
  );
}
