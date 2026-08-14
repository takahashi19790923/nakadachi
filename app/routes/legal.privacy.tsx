import { Link } from "react-router";

import { LegalPage } from "~/components/legal-page";
import { SITE } from "~/config/site";
import { buildPageMeta } from "~/domain/seo";
import type { Route } from "./+types/legal.privacy";
import { getApp } from "~/server/app-context";

export function loader({ context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  return { origin: context.env.APP_ORIGIN };
}

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return buildPageMeta({
    title: `プライバシーポリシー | ${SITE.name}`,
    description: `${SITE.name}における個人情報の取扱いについて定めています。`,
    path: "/legal/privacy",
    origin: loaderData?.origin,
  });
}

export default function Privacy() {
  return (
    <LegalPage title="プライバシーポリシー" lastUpdated="2026年8月13日">
      <h2>1. 取得する情報</h2>
      <ul>
        <li>
          <strong>メールアドレス</strong>：ログインおよび通知のために取得します。
        </li>
        <li>
          <strong>プロフィール情報</strong>：表示名、自己紹介、活動地域。
          表示名と自己紹介は投稿ページに公開されます。
        </li>
        <li>
          <strong>投稿内容</strong>：タイトル、説明、価格、地域、写真。
          公開中の投稿は誰でも閲覧できます。
        </li>
        <li>
          <strong>メッセージ</strong>：利用者間のやり取りの内容。
        </li>
        <li>
          <strong>決済に関する情報</strong>：決済の金額、状態、識別子。
          <strong>
            クレジットカード番号は当サービスでは受け取らず、保存もしません。
          </strong>
          決済事業者（Stripe）が直接処理します。
        </li>
        <li>
          <strong>アクセスに関する情報</strong>：接続元IPアドレス、
          ブラウザの種類、閲覧日時。
        </li>
      </ul>

      <h2>2. 保存の方法</h2>
      <ul>
        <li>
          <strong>メールアドレスは暗号化して保存します。</strong>
          検索・重複確認のためには、別の鍵で作成した一方向の索引値を用います。
        </li>
        <li>
          <strong>IPアドレスはそのままの形では保存しません。</strong>
          鍵付きのハッシュ値に変換して保存します。
        </li>
        <li>
          ログイン用のトークンおよび確認コードは、ハッシュ化して保存します。
          有効期限があり、一度使用すると再利用できません。
        </li>
        <li>写真から、位置情報を含む付帯情報を可能な範囲で取り除きます。</li>
      </ul>

      <h2>3. 利用目的</h2>
      <ul>
        <li>本サービスの提供、本人確認、認証</li>
        <li>掲載料の決済処理</li>
        <li>お問い合わせへの対応</li>
        <li>規約違反の調査、不正利用の防止</li>
        <li>サービスの改善（個人を特定しない統計として）</li>
      </ul>
      <p>
        取得した情報を、上記の目的以外に利用することはありません。
        広告配信および広告目的での第三者提供は行いません。
      </p>

      <h2>4. 第三者への提供</h2>
      <p>
        次の場合を除き、本人の同意なく個人情報を第三者へ提供することはありません。
      </p>
      <ul>
        <li>法令に基づく場合</li>
        <li>人の生命、身体または財産の保護のために必要な場合</li>
        <li>
          裁判所、警察等の公的機関から、法令に基づく正当な手続きにより
          開示を求められた場合
        </li>
      </ul>

      <h3>業務委託先</h3>
      <p>
        サービスの提供のため、次の事業者を利用しています。
        いずれも、業務の遂行に必要な範囲でのみ情報を取り扱います。
      </p>
      <ul>
        <li>Cloudflare, Inc.（アプリケーションの実行、写真の保存）</li>
        <li>Neon Inc.（データベース）</li>
        <li>Stripe, Inc.（決済処理）</li>
        <li>Resend（メール送信）</li>
      </ul>
      <p>
        これらの事業者のうち、一部は日本国外にサーバーを置いています。
        利用者情報は、当該国の法制度のもとで取り扱われることがあります。
      </p>

      <h2>5. Cookie の利用</h2>
      <p>
        ログイン状態の維持、および不正な要求の検出（CSRF対策）のために
        Cookie を使用します。<strong>広告目的の Cookie は使用していません。</strong>
        アクセス解析ツールも導入していません。
      </p>
      <p>
        Cookie の詳細な取扱いは
        <a className="link mx-1" href={SITE.legal.cookiesUrl} rel="noopener noreferrer">
          Cookieポリシー
        </a>
        をご覧ください。
      </p>

      <h2>6. 保存期間と削除</h2>
      <ul>
        <li>
          退会をお申し込みいただくと、<strong>30日後</strong>にアカウント、
          投稿、写真、メッセージを削除します。それまでは取り消せます。
        </li>
        <li>
          法令により保存が義務づけられている決済の記録は、
          個人が特定できない形にしたうえで保管します。
        </li>
        <li>
          管理操作の記録（監査ログ）は、個人情報を含まない形で保管します。
        </li>
        <li>
          期限切れの認証トークン、セッションは、定期的に削除します。
        </li>
      </ul>

      <h2>7. 開示・訂正・利用停止の請求</h2>
      <p>
        ご自身の情報について、開示、訂正、追加、削除、利用の停止を
        請求できます。
        <Link to="/contact" className="link mx-1">
          お問い合わせ
        </Link>
        からご連絡ください。ご本人であることを確認したうえで対応します。
      </p>

      <h2>8. 安全管理</h2>
      <ul>
        <li>通信はすべて暗号化しています（HTTPS）。</li>
        <li>
          管理画面へのアクセスには、通常のログインに加えて2段階の追加確認を
          設けています。
        </li>
        <li>管理者による操作は、すべて記録されます。</li>
      </ul>

      <h2>9. 改定</h2>
      <p>
        本ポリシーを変更する場合は、本サービス上に掲示します。
        重要な変更については、あらかじめ通知します。
      </p>
    </LegalPage>
  );
}
