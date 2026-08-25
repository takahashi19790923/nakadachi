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

/**
 * 委託先の一覧。
 *
 * ★ここは実態と必ず一致させる。★ 2026-08-18 に本番のデータベースを
 * Neon（シンガポール）から Supabase（東京）へ移したとき、この一覧の更新が
 * 漏れ、★実際にデータを預けている事業者が書かれていない★状態が
 * できていた（2026-08-25 の公開前監査で発覚）。委託先を変えるときは、
 * 同じコミットでここも直す。DEPLOYMENT.md の変更手順にも項目がある。
 *
 * 実際に接続している先とのずれは test/privacy-processors.test.ts で
 * 突き合わせている。
 */
const PROCESSORS = [
  {
    name: "Cloudflare, Inc.",
    data: "アプリケーションの実行、写真の保存、データベースの写しの保管、ボットの判定",
    location: "日本（東京）ほか、世界各地の拠点",
  },
  {
    name: "Supabase, Inc.",
    data: "データベース（アカウント、投稿、メッセージ、決済の記録、発信者情報）",
    location: "日本（東京）",
  },
  {
    name: "Stripe, Inc.",
    data: "決済処理（お支払いの情報、メールアドレス）",
    location: "アメリカ合衆国",
  },
  {
    name: "Resend (Plus Five Five, Inc.)",
    data: "メール送信（宛先のメールアドレス、本文）",
    location: "アメリカ合衆国",
  },
] as const;

export default function Privacy() {
  return (
    <LegalPage title="プライバシーポリシー" lastUpdated="2026年8月25日">
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
          <strong>IPアドレスは、用途によって保存の方法が異なります。</strong>
          ログインの記録や不正利用の防止に用いるものは、鍵付きのハッシュ値に
          変換して保存し、元のアドレスに戻せない形にします。
        </li>
        <li>
          <strong>
            次の操作については、接続元IPアドレスとブラウザの情報を、暗号化した形で
            6か月間保存します。
          </strong>
          会員登録、ログイン、掲載の申し込み、メッセージの送信、通報。
          取引に関する被害が生じたときに、法令に基づく開示の求めへお答えできる
          ようにするためです。6か月を過ぎたものは自動的に削除します。
          運営者が業務上必要と判断した場合を除き、参照しません。参照した事実は
          記録に残します。
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

      <h3>業務委託先と、国外への移転</h3>
      <p>
        サービスの提供のため、次の事業者を利用しています。
        いずれも、業務の遂行に必要な範囲でのみ情報を取り扱います。
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-washi-300 text-left">
              <th className="py-2 pr-4 font-medium">事業者</th>
              <th className="py-2 pr-4 font-medium">取り扱う情報</th>
              <th className="py-2 pr-4 font-medium">データの所在</th>
            </tr>
          </thead>
          <tbody>
            {PROCESSORS.map((row) => (
              <tr key={row.name} className="border-b border-washi-200 align-top">
                <td className="py-2 pr-4">{row.name}</td>
                <td className="py-2 pr-4">{row.data}</td>
                <td className="py-2 pr-4">{row.location}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        このうち <strong>Stripe, Inc. および Resend</strong> は、
        情報を<strong>アメリカ合衆国</strong>で取り扱います。
        Cloudflare, Inc. と Supabase, Inc. はアメリカ合衆国の法人ですが、
        本サービスの情報は上の表に記した地域に保存しています。
      </p>
      <p>
        アメリカ合衆国には、日本の個人情報保護法に相当する包括的な法律は
        ありません。分野ごとの法律と、州ごとの法律によって規律されています。
        また、いずれの国においても、その国の法令に基づく政府機関からの
        開示要求の対象となることがあります。
        各事業者とは、個人情報の取扱いについて契約を結んでいます。
      </p>

      <h3>お客様の端末から外部へ送信される情報</h3>
      <p>
        本サービスの一部の画面では、お客様のブラウザから次の事業者へ
        直接情報が送信されます（電気通信事業法第27条の12に基づく公表）。
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-washi-300 text-left">
              <th className="py-2 pr-4 font-medium">送信先</th>
              <th className="py-2 pr-4 font-medium">送信される情報</th>
              <th className="py-2 pr-4 font-medium">利用目的</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-washi-200 align-top">
              <td className="py-2 pr-4">
                Cloudflare, Inc.
                <span className="mt-1 block text-washi-600">
                  （Turnstile。ログイン、投稿、問い合わせ等のフォームで
                  読み込まれます）
                </span>
              </td>
              <td className="py-2 pr-4">
                ブラウザおよび端末の情報、画面上の操作の特徴、
                接続元IPアドレス、Cloudflare が発行する Cookie
              </td>
              <td className="py-2 pr-4">
                自動化された不正な操作（ボット）の判定。
                広告や行動の分析には利用されません。
              </td>
            </tr>
            <tr className="border-b border-washi-200 align-top">
              <td className="py-2 pr-4">
                Stripe, Inc.
                <span className="mt-1 block text-washi-600">
                  （お支払いに進んだときのみ。Stripe の画面へ移動します）
                </span>
              </td>
              <td className="py-2 pr-4">
                お支払い手続きの際にお客様が入力する情報、
                接続元IPアドレス、ブラウザの情報
              </td>
              <td className="py-2 pr-4">決済の処理および不正利用の防止</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        本サービスは、<strong>広告配信および行動分析のための送信は行っていません。</strong>
      </p>

      <h2>5. Cookie の利用</h2>
      <p>
        ログイン状態の維持、および不正な要求の検出（CSRF対策）のために
        Cookie を使用します。<strong>広告目的の Cookie は使用していません。</strong>
        アクセス解析ツールも導入していません。
      </p>
      <p>
        このほか、ボットの判定のために Cloudflare Turnstile が
        Cookie を発行することがあります。詳しくは
        「お客様の端末から外部へ送信される情報」をご覧ください。
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
          <strong>
            掲載が終了した投稿（掲載終了・期限切れ・削除・掲載不可）は、
            終了から3か月で写真を、6か月で本文とやり取りの履歴を削除します。
          </strong>
          公開中の投稿は削除しません。返金や申し立てへの対応のため停止している
          投稿も、対応が終わるまで削除しません。
        </li>
        <li>
          法令により保存が義務づけられている決済の記録は、
          <strong>7年間</strong>保管します。退会された場合は、
          個人が特定できない形にしたうえで保管します。
        </li>
        <li>
          管理操作の記録（監査ログ）は、個人情報を含まない形で保管します。
        </li>
        <li>
          <strong>
            発信者情報（会員登録・ログイン・掲載の申し込み・メッセージ送信・
            通報を行った際の接続元IPアドレスとブラウザの情報）は、
            記録した日から6か月間保存し、その後自動的に削除します。
          </strong>
          退会をお申し込みいただいた場合も、この6か月は変わりません。
          退会後に取引の被害が判明することがあり、そのときに開示の求めへ
          お答えできなくなるためです。
        </li>
        <li>
          期限切れの認証トークン、セッションは、定期的に削除します。
        </li>
        <li>
          <strong>
            障害に備えて、データベース全体の写しを毎日取得し、
            14日分を保管しています。
          </strong>
          上のとおり削除した情報も、この写しの中には
          <strong>最長14日間</strong>残り、その後は写しごと自動的に消えます。
          写しは暗号化された保管領域に置き、障害からの復旧以外の目的では
          参照しません。
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
