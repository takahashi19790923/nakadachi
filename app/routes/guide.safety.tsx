import { Link } from "react-router";

import { LegalPage } from "~/components/legal-page";
import { SITE } from "~/config/site";
import { buildPageMeta } from "~/domain/seo";
import type { Route } from "./+types/guide.safety";
import { getApp } from "~/server/app-context";

export function loader({ context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  return { origin: context.env.APP_ORIGIN };
}

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return buildPageMeta({
    title: `安全な取引のためのガイド | ${SITE.name}`,
    description:
      "対面での受け渡し、支払い、個人情報の扱いについて、気をつけたいことをまとめています。",
    path: "/guide/safety",
    origin: loaderData?.origin,
  });
}

export default function SafetyGuide() {
  return (
    <LegalPage
      title="安全な取引のためのガイド"
      lastUpdated="2026年8月13日"
      showTemplateNotice={false}
    >
      <p>
        {SITE.name}は取引の場を提供するもので、
        <strong>取引の当事者ではありません。</strong>
        代金の預かりも、身元の保証も行いません。
        だからこそ、次の点にご注意ください。
      </p>

      <h2>公開する情報について</h2>
      <ul>
        <li>
          <strong>番地・部屋番号・電話番号は投稿に書かないでください。</strong>
          投稿は誰でも閲覧できます。地域は市区町村までにとどめ、
          待ち合わせ場所は「〇〇駅の近く」のように広めに書いてください。
        </li>
        <li>
          写真に表札、郵便物、車のナンバー、窓からの景色が写っていないか
          確認してください。住所が分かってしまうことがあります。
        </li>
        <li>
          写真に含まれる位置情報などの付帯情報は、こちらで取り除いています。
          ただし、写っているものから場所が分かることは防げません。
        </li>
      </ul>

      <h2>対面で受け渡すとき</h2>
      <ul>
        <li>
          <strong>自宅を待ち合わせ場所にしない。</strong>
          駅、商業施設、公共施設など、人の目がある場所を選んでください。
        </li>
        <li>明るい時間帯を選んでください。</li>
        <li>
          可能であれば、家族や友人に「誰と・どこで・何時に会うか」を
          伝えておいてください。
        </li>
        <li>
          相手の車に乗る、相手を自宅に招き入れる、といったことは避けてください。
        </li>
        <li>
          少しでも不安を感じたら、その場で取引をやめて構いません。
          断ることは失礼ではありません。
        </li>
      </ul>

      <h2>お金のやり取り</h2>
      <ul>
        <li>
          <strong>先払いを求められたら、いったん立ち止まってください。</strong>
          「送金してくれれば発送する」という手口の詐欺が多く報告されています。
        </li>
        <li>
          コンビニで電子マネーを買って番号を伝える、ギフトカードのコードを送る、
          といった支払い方法は<strong>絶対に使わないでください</strong>。
          取り戻せません。
        </li>
        <li>
          高額な取引では、対面での現金のやり取りか、記録の残る方法を選んでください。
        </li>
        <li>
          <strong>デポジット（保証金）は当サービスでは預かりません。</strong>
          「貸します」の取引でデポジットを扱う場合、金額と返却の条件を
          事前に文章で残しておいてください。
        </li>
      </ul>

      <h2>やり取りの場所</h2>
      <ul>
        <li>
          <strong>できるだけサイト内のメッセージで進めてください。</strong>
          記録が残り、通報の際に運営者が確認できます。
        </li>
        <li>
          早い段階で外部のSNSやメッセージアプリへ誘導されたら、
          理由を確かめてください。記録を残したくない意図があることがあります。
        </li>
        <li>
          <strong>本人確認書類の画像を送らないでください。</strong>
          個人間の取引で必要になることはありません。
        </li>
      </ul>

      <h2>求人に応募するとき</h2>
      <ul>
        <li>
          仕事の内容が具体的に書かれていない、報酬が相場より極端に高い募集は
          警戒してください。
        </li>
        <li>
          <strong>応募にあたって金銭の支払いを求められたら、応じないでください。</strong>
        </li>
        <li>
          身分証の写真、銀行口座、家族構成を、面接前の段階で求められた場合は
          応じないでください。
        </li>
        <li>
          賃金、労働時間、就業場所が明示されていない募集は、
          法令上の問題があります。通報してください。
        </li>
      </ul>

      <h2>困ったときは</h2>
      <ul>
        <li>
          規約に反する投稿は、投稿ページの「この投稿を通報する」からお知らせください。
        </li>
        <li>
          特定の相手からの連絡を止めたい場合は、メッセージ画面からブロックできます。
          ブロックしたことは相手に通知されません。
        </li>
        <li>
          詐欺や犯罪の被害にあった、またはそのおそれがある場合は、
          <strong>警察相談専用電話「#9110」</strong>、
          消費生活の相談は<strong>「188」</strong>（消費者ホットライン）へ
          ご相談ください。
        </li>
        <li>
          サービスについてのご相談は
          <Link to="/contact" className="link mx-1">
            お問い合わせ
          </Link>
          からどうぞ。
        </li>
      </ul>
    </LegalPage>
  );
}
