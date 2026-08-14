import { Link } from "react-router";

import { LegalPage } from "~/components/legal-page";
import { SITE } from "~/config/site";
import { buildPageMeta } from "~/domain/seo";
import type { Route } from "./+types/legal.prohibited";
import { getApp } from "~/server/app-context";

export function loader({ context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  return { origin: context.env.APP_ORIGIN };
}

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return buildPageMeta({
    title: `禁止行為・禁止出品物 | ${SITE.name}`,
    description:
      "掲載できないもの、行ってはいけない行為をまとめています。掲載前に必ずご確認ください。",
    path: "/legal/prohibited",
    origin: loaderData?.origin,
  });
}

export default function Prohibited() {
  return (
    <LegalPage title="禁止行為・禁止出品物" lastUpdated="2026年8月13日">
      <p>
        次のものは掲載できません。掲載が確認された場合、事前の通知なく非公開と
        し、繰り返される場合はアカウントの利用を停止します。
        <strong>この場合、掲載料の返金はありません。</strong>
      </p>

      <h2>掲載できないもの</h2>

      <h3>法令に反するもの</h3>
      <ul>
        <li>法令で所持・譲渡・販売が禁止されているもの全般</li>
        <li>盗品、および盗品と知りながら取得したもの</li>
        <li>偽造品、模倣品、海賊版（ブランド品の模倣、複製したソフトウェアなど）</li>
        <li>詐欺的な商品・サービス</li>
      </ul>

      <h3>武器・危険物</h3>
      <ul>
        <li>銃砲、刀剣類、模造銃、これらの部品</li>
        <li>スタンガン、催涙スプレーなど、人に危害を加える目的の器具</li>
        <li>火薬、花火（規制対象のもの）、可燃性の高い液体・気体</li>
        <li>毒物、劇物、放射性物質、アスベストを含む建材</li>
      </ul>

      <h3>医薬品・健康に関わるもの</h3>
      <ul>
        <li>医薬品、医薬部外品（許可なく販売できないもの）</li>
        <li>処方箋が必要な医薬品、および使いかけの医薬品</li>
        <li>コンタクトレンズ、医療機器（許可が必要なもの）</li>
        <li>効果効能をうたった健康食品・器具で、法令の基準を満たさないもの</li>
      </ul>

      <h3>薬物・たばこ・酒類</h3>
      <ul>
        <li>麻薬、覚醒剤、大麻、危険ドラッグ、およびそれらを想起させるもの</li>
        <li>許可のないたばこ、電子たばこのリキッド</li>
        <li>酒類（酒類販売業免許が必要です）</li>
      </ul>

      <h3>個人情報・アカウント・金融</h3>
      <ul>
        <li>他人の個人情報、名簿、連絡先の一覧</li>
        <li>SNS・ゲーム・その他サービスのアカウント、およびその中の資産</li>
        <li>銀行口座、キャッシュカード、クレジットカード、電子マネーの譲渡</li>
        <li>携帯電話、SIMカードの他人名義での譲渡</li>
        <li>現金、金券、有価証券、暗号資産（換金目的での出品）</li>
      </ul>

      <h3>成人向け・公序良俗に反するもの</h3>
      <ul>
        <li>成人向けの商品、サービス、画像</li>
        <li>性的なサービスを想起させる募集</li>
        <li>使用済みの下着、体液、その他衛生上問題のあるもの</li>
      </ul>

      <h3>許可・資格が必要なもの</h3>
      <ul>
        <li>
          中古品の反復継続的な売買（古物商許可が必要な場合があります）
        </li>
        <li>食品（食品衛生法上の許可が必要な場合があります）</li>
        <li>動植物（種の保存法、動物愛護法などの規制対象となるもの）</li>
        <li>不動産の仲介（宅地建物取引業の免許が必要です）</li>
        <li>
          有償での運送、人材の紹介・派遣（それぞれ許可・届出が必要です）
        </li>
      </ul>

      <h2>求人の掲載について</h2>
      <p>
        「お仕事」カテゴリでは、次の内容を掲載できません。
      </p>
      <ul>
        <li>
          <strong>差別的な募集条件</strong>
          ：性別、年齢、国籍、信条、社会的身分、障害の有無などによる制限
          （法令で認められる場合を除きます）
        </li>
        <li>
          <strong>法令に反する労働条件</strong>
          ：最低賃金を下回る賃金、法定の上限を超える労働時間、
          割増賃金を支払わない前提の募集
        </li>
        <li>賃金、労働時間、就業場所を明示しない募集</li>
        <li>
          高額な報酬をうたい、内容を明示しない募集
          （いわゆる「闇バイト」に該当するおそれのあるもの）
        </li>
        <li>応募者に金銭の支払い、物品の購入を求める募集</li>
        <li>実態のない募集、個人情報の収集のみを目的とする募集</li>
      </ul>

      <h2>禁止されている行為</h2>
      <ul>
        <li>虚偽の情報、誇大な表現による掲載</li>
        <li>同一または類似の内容を繰り返し掲載する行為</li>
        <li>本サービスを通じて知り合った相手を、外部の勧誘に誘導する行為</li>
        <li>宗教活動、政治活動、マルチ商法、投資の勧誘</li>
        <li>他の利用者への嫌がらせ、脅迫、差別的な言動</li>
        <li>他人になりすます行為</li>
        <li>取引に関係のない個人情報を、相手に要求する行為</li>
        <li>本サービスの管理者を装う行為</li>
        <li>自動化された手段による大量の投稿、閲覧、収集</li>
      </ul>

      <h2>見つけた場合は</h2>
      <p>
        該当する投稿を見つけた場合は、投稿ページの「この投稿を通報する」から
        お知らせください。運営者が確認します。
      </p>
      <p>
        安全に取引するための注意点は
        <Link to="/guide/safety" className="link mx-1">
          安全な取引のためのガイド
        </Link>
        をご覧ください。
      </p>
    </LegalPage>
  );
}
