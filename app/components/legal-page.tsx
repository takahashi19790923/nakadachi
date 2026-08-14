import { Link } from "react-router";

import { SITE } from "~/config/site";

/**
 * 規約類の共通の枠。
 *
 * ★JavaScript が無くても読めること。★ 法定文書の表示に JS を要求しない。
 * ★運営者情報（氏名・住所・連絡先）をここに書かない。★
 * 正本は rewrite-co.com/legal/ にあり、絶対URLで参照するだけにする。
 */
export function LegalPage({
  title,
  lastUpdated,
  children,
  showTemplateNotice = true,
}: {
  title: string;
  lastUpdated: string;
  children: React.ReactNode;
  showTemplateNotice?: boolean;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-washi-900">{title}</h1>
      <p className="mt-2 text-sm text-washi-600">最終改定日：{lastUpdated}</p>

      {showTemplateNotice ? (
        <div className="mt-4 rounded-lg border border-kaki-300 bg-kaki-50 p-4 text-sm text-kaki-900">
          <p className="font-semibold">この文書はひな型です</p>
          <p className="mt-1">
            日本法に詳しい専門家の確認を受けたものではありません。
            本番公開の前に必ず確認を受けてください。
          </p>
        </div>
      ) : null}

      <div className="prose mt-6 max-w-none text-washi-800 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:text-washi-900 [&_h3]:mt-6 [&_h3]:font-semibold [&_li]:mt-1 [&_ol]:mt-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:mt-3 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-6">
        {children}
      </div>

      <div className="mt-10 rounded-lg border border-washi-200 bg-white p-4 text-sm">
        <p className="font-semibold text-washi-900">運営者について</p>
        <p className="mt-1 text-washi-700">
          販売事業者・運営統括責任者・所在地・連絡先は、次のページに記載しています。
        </p>
        <p className="mt-2">
          <a
            className="link"
            href={SITE.legal.operatorUrl}
            rel="noopener noreferrer"
          >
            運営者情報を見る
          </a>
        </p>
      </div>

      <p className="mt-6 text-sm">
        <Link to="/contact" className="link">
          この内容についてのお問い合わせ
        </Link>
      </p>
    </div>
  );
}
