import { LegalPage } from "~/components/legal-page";
import { SITE } from "~/config/site";
import { LISTING_FEE_JPY, formatJpy } from "~/domain/pricing";
import { buildPageMeta } from "~/domain/seo";
import type { Route } from "./+types/legal.tokushoho";
import { getApp } from "~/server/app-context";

export function loader({ context: rawContext }: Route.LoaderArgs) {
  const context = getApp(rawContext);
  return { origin: context.env.APP_ORIGIN };
}

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return buildPageMeta({
    title: `特定商取引法に基づく表記 | ${SITE.name}`,
    description: `${SITE.name}の掲載料（1件${LISTING_FEE_JPY}円・税込）に関する表記です。`,
    path: "/legal/tokushoho",
    origin: loaderData?.origin,
  });
}

/**
 * 特定商取引法に基づく表記。
 *
 * ★販売事業者・所在地・電話番号・メールアドレスをここに書かない。★
 * 正本は rewrite-co.com/legal/#operator にあり、そちらを参照する。
 * 各サービスに複製すると、住所を変えたときにどれかが必ず古くなる。
 *
 * ★価格は1つだけ書けばよい。★ 日本国内向けの単一通貨・単一価格のため。
 * 多市場へ展開する場合は、国コードで併記すること。
 */
export default function Tokushoho() {
  return (
    <LegalPage title="特定商取引法に基づく表記" lastUpdated="2026年8月13日">
      <table className="mt-6 w-full border-collapse text-sm">
        <tbody>
          <Row label="販売事業者・運営統括責任者・所在地・連絡先">
            <a className="link" href={SITE.legal.operatorUrl} rel="noopener noreferrer">
              運営者情報のページ
            </a>
            に記載しています。
            <span className="mt-1 block text-washi-600">
              （請求があった場合は遅滞なく開示します）
            </span>
          </Row>
          <Row label="販売価格">
            投稿の掲載料：1件につき{formatJpy(LISTING_FEE_JPY)}（税込）
            <span className="mt-1 block text-washi-600">
              投稿の閲覧および会員登録は無料です。
            </span>
          </Row>
          <Row label="商品代金以外の必要料金">
            ありません。成約手数料、月額利用料、更新料はいただきません。
            インターネットの接続料金および通信料金は利用者のご負担となります。
          </Row>
          <Row label="支払方法">
            クレジットカード等（決済事業者 Stripe の提供する方法）
          </Row>
          <Row label="支払時期">投稿の公開手続きの際、その場でお支払いいただきます。</Row>
          <Row label="役務の提供時期">
            お支払いの確認後、ただちに投稿を公開します。
            通常は数秒以内ですが、決済方法によっては入金の確認までお時間をいただきます。
          </Row>
          <Row label="掲載期間">
            投稿ごとに7日・14日・30日・60日・90日から選択いただきます（既定は30日）。
            期間の満了により掲載は自動的に終了します。
            <strong className="mt-1 block">自動更新および自動課金は行いません。</strong>
          </Row>
          <Row label="返品・キャンセルについて">
            役務の性質上、公開後のキャンセルおよび返金はお受けできません。
            公開前（下書きの状態）であれば料金は発生しません。
            <span className="mt-1 block text-washi-600">
              当方の責めに帰すべき事由により投稿が公開されなかった場合は、
              お問い合わせのうえ個別に対応いたします。
            </span>
          </Row>
          <Row label="動作環境">
            最新版の Google Chrome、Safari、Microsoft Edge、Firefox
          </Row>
        </tbody>
      </table>

      <h2>本サービスの位置づけ</h2>
      <p>
        本サービスは、利用者どうしの取引の場を提供するものです。
        当方は掲載の場を提供する事業者であり、利用者間で行われる個々の取引の
        当事者ではありません。個々の取引について、当方は特定商取引法上の
        販売業者にはあたりません。
      </p>
    </LegalPage>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <tr className="border-b border-washi-200">
      <th
        scope="row"
        className="w-1/3 py-3 pr-4 text-left align-top font-semibold text-washi-700"
      >
        {label}
      </th>
      <td className="py-3 align-top text-washi-900">{children}</td>
    </tr>
  );
}
