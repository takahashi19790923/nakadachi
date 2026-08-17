/**
 * 通報の理由と表示名。
 *
 * ★依存を持たない専用ファイルにしてある。★ 以前は validation/interaction.ts に
 * 置いていたが、あのファイルは先頭で zod の日本語化を副作用 import している。
 * 表示名を1つ import しただけで★zod 本体と日本語ロケール（70KB）が
 * ブラウザ側バンドルへ引き込まれ★、通報画面・通報一覧・管理の通報一覧の
 * 3画面が7つのラジオボタンの文言のためにそれを落としていた
 * （2026-08-17 の点検で発覚。form-fields.ts / list-params.ts と同じ理由）。
 *
 * DB の enum（app/db/schema/enums.ts）もここから作る。値を足すときは
 * ここだけ変えればよい。
 */
export const REPORT_REASONS = [
  "prohibited_item",
  "spam",
  "fraud",
  "harassment",
  "personal_info",
  "illegal_job",
  "other",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABEL: Readonly<Record<ReportReason, string>> = {
  prohibited_item: "禁止されている出品物・サービス",
  spam: "宣伝・スパム・無関係な内容",
  fraud: "詐欺・なりすましの疑い",
  harassment: "嫌がらせ・攻撃的な言動",
  personal_info: "他人の個人情報が含まれている",
  illegal_job: "法令に反する労働条件・差別的な求人",
  other: "その他",
};
