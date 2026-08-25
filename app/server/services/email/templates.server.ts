import { SITE } from "~/config/site";
import { LISTING_FEE_JPY, formatJpy } from "~/domain/pricing";

/**
 * メール文面。
 *
 * ★文面はコード側に組み込みで持つ。★ DB に入れると、DB が空の環境で
 * 何も送れなくなる。将来オーバーライドが要るなら「DB に行があればそれを使い、
 * 無ければ組み込みに落ちる」形にする。
 *
 * ★利用者の入力を必ずエスケープする。★ 投稿タイトルや表示名がそのまま
 * HTML に入るので、`<img onerror=...>` のような文字列を書かれると、
 * 受信側のメールクライアントによっては危険な描画になる。
 */

/** HTML に埋める前に必ず通す */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface EmailContent {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/**
 * 共通の外枠。
 * メールクライアントは CSS の対応がまちまちなので、インラインの style だけを使う。
 */
function layout(options: {
  heading: string;
  bodyHtml: string;
  bodyText: string;
  actionUrl?: string;
  actionLabel?: string;
}): { html: string; text: string } {
  const action = options.actionUrl
    ? `<p style="margin:24px 0"><a href="${escapeHtml(options.actionUrl)}" style="display:inline-block;background:#2d4b5e;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">${escapeHtml(options.actionLabel ?? "開く")}</a></p>`
    : "";

  const html = `<!doctype html>
<html lang="ja">
<body style="margin:0;padding:24px;background:#fcfbf8;font-family:sans-serif;color:#26241e;line-height:1.8">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #ebe7dd;border-radius:12px;padding:24px">
    <p style="margin:0 0 16px;font-weight:bold;color:#2d4b5e">${escapeHtml(SITE.name)}</p>
    <h1 style="margin:0 0 16px;font-size:18px">${escapeHtml(options.heading)}</h1>
    ${options.bodyHtml}
    ${action}
    <hr style="border:none;border-top:1px solid #ebe7dd;margin:24px 0">
    <p style="margin:0;font-size:12px;color:#6d6759">
      このメールは ${escapeHtml(SITE.name)} から送信されています。<br>
      お問い合わせ: ${escapeHtml(SITE.supportEmail)}
    </p>
  </div>
</body>
</html>`;

  const text = [
    SITE.name,
    "",
    options.heading,
    "",
    options.bodyText,
    options.actionUrl ? `\n${options.actionLabel ?? "開く"}: ${options.actionUrl}` : "",
    "",
    "----",
    `お問い合わせ: ${SITE.supportEmail}`,
  ]
    .filter(Boolean)
    .join("\n");

  return { html, text };
}

// ── 1. ログインリンク / OTP ────────────────────────────────────────

export function loginCodeEmail(options: {
  otp: string;
  linkUrl: string;
  expiresInMinutes: number;
}): EmailContent {
  const { html, text } = layout({
    heading: "ログイン用の確認コード",
    bodyHtml: `
      <p style="margin:0 0 12px">下の確認コードを画面に入力してください。</p>
      <p style="margin:0 0 12px;font-size:28px;letter-spacing:6px;font-weight:bold;font-family:monospace">${escapeHtml(options.otp)}</p>
      <p style="margin:0 0 12px">リンクを開いてログインすることもできます。</p>
      <p style="margin:0;font-size:13px;color:#6d6759">
        有効期限は${options.expiresInMinutes}分です。一度使うと無効になります。<br>
        心当たりがない場合は、このメールを破棄してください。何も起きません。
      </p>`,
    bodyText: [
      "下の確認コードを画面に入力してください。",
      "",
      `確認コード: ${options.otp}`,
      "",
      `有効期限は${options.expiresInMinutes}分です。一度使うと無効になります。`,
      "心当たりがない場合は、このメールを破棄してください。何も起きません。",
    ].join("\n"),
    actionUrl: options.linkUrl,
    actionLabel: "リンクでログインする",
  });

  return { subject: `【${SITE.name}】ログイン用の確認コード`, html, text };
}

// ── 2. 掲載完了 ────────────────────────────────────────────────────

export function listingPublishedEmail(options: {
  title: string;
  listingUrl: string;
  expiresAt: string;
}): EmailContent {
  const { html, text } = layout({
    heading: "投稿を公開しました",
    bodyHtml: `
      <p style="margin:0 0 12px">掲載料 ${formatJpy(LISTING_FEE_JPY)}（税込）のお支払いを確認し、投稿を公開しました。</p>
      <p style="margin:0 0 12px"><strong>${escapeHtml(options.title)}</strong></p>
      <p style="margin:0 0 12px">掲載終了予定日：${escapeHtml(options.expiresAt)}</p>
      <p style="margin:0;font-size:13px;color:#6d6759">
        取引が決まったら、マイページから掲載を終了できます。<br>
        正確な住所や電話番号は投稿に書かないでください。
      </p>`,
    bodyText: [
      `掲載料 ${formatJpy(LISTING_FEE_JPY)}（税込）のお支払いを確認し、投稿を公開しました。`,
      "",
      options.title,
      `掲載終了予定日：${options.expiresAt}`,
      "",
      "取引が決まったら、マイページから掲載を終了できます。",
    ].join("\n"),
    actionUrl: options.listingUrl,
    actionLabel: "投稿を見る",
  });

  return { subject: `【${SITE.name}】投稿を公開しました`, html, text };
}

// ── 3. 決済失敗 ────────────────────────────────────────────────────

export function paymentFailedEmail(options: {
  title: string;
  retryUrl: string;
}): EmailContent {
  const { html, text } = layout({
    heading: "お支払いを確認できませんでした",
    bodyHtml: `
      <p style="margin:0 0 12px">次の投稿の掲載料をお預かりできませんでした。投稿は下書きとして残っています。</p>
      <p style="margin:0 0 12px"><strong>${escapeHtml(options.title)}</strong></p>
      <p style="margin:0;font-size:13px;color:#6d6759">
        カードの有効期限や利用限度額をご確認のうえ、もう一度お試しください。<br>
        料金が二重に請求されることはありません。
      </p>`,
    bodyText: [
      "次の投稿の掲載料をお預かりできませんでした。投稿は下書きとして残っています。",
      "",
      options.title,
      "",
      "カードの有効期限や利用限度額をご確認のうえ、もう一度お試しください。",
      "料金が二重に請求されることはありません。",
    ].join("\n"),
    actionUrl: options.retryUrl,
    actionLabel: "もう一度手続きする",
  });

  return { subject: `【${SITE.name}】お支払いを確認できませんでした`, html, text };
}

// ── 4. 新着メッセージ ──────────────────────────────────────────────

export function newMessageEmail(options: {
  listingTitle: string;
  threadUrl: string;
}): EmailContent {
  // ★本文をメールに載せない。★ 受信箱に会話が溜まると、端末を他人に見られた
  // ときの被害が大きい。件名にも相手の表示名を出さない。
  const { html, text } = layout({
    heading: "新しいメッセージが届いています",
    bodyHtml: `
      <p style="margin:0 0 12px">投稿「${escapeHtml(options.listingTitle)}」に新しいメッセージが届きました。</p>
      <p style="margin:0;font-size:13px;color:#6d6759">
        メッセージの内容はサイト内でご確認ください。<br>
        通知が不要な場合は、マイページの設定から止められます。
      </p>`,
    bodyText: [
      `投稿「${options.listingTitle}」に新しいメッセージが届きました。`,
      "",
      "メッセージの内容はサイト内でご確認ください。",
    ].join("\n"),
    actionUrl: options.threadUrl,
    actionLabel: "メッセージを見る",
  });

  return { subject: `【${SITE.name}】新しいメッセージが届いています`, html, text };
}

// ── 5. 掲載期限の通知 ──────────────────────────────────────────────

export function listingExpiringEmail(options: {
  title: string;
  listingUrl: string;
  daysLeft: number;
}): EmailContent {
  const { html, text } = layout({
    heading: "まもなく掲載期間が終わります",
    bodyHtml: `
      <p style="margin:0 0 12px">次の投稿は、あと${options.daysLeft}日で掲載期間が終わります。</p>
      <p style="margin:0 0 12px"><strong>${escapeHtml(options.title)}</strong></p>
      <p style="margin:0;font-size:13px;color:#6d6759">
        掲載を続けたい場合は、期間終了後にあらためて投稿してください（掲載料 ${formatJpy(LISTING_FEE_JPY)} がかかります）。<br>
        自動で更新・課金されることはありません。
      </p>`,
    bodyText: [
      `次の投稿は、あと${options.daysLeft}日で掲載期間が終わります。`,
      "",
      options.title,
      "",
      `掲載を続けたい場合は、期間終了後にあらためて投稿してください（掲載料 ${formatJpy(LISTING_FEE_JPY)} がかかります）。`,
      "自動で更新・課金されることはありません。",
    ].join("\n"),
    actionUrl: options.listingUrl,
    actionLabel: "投稿を見る",
  });

  return { subject: `【${SITE.name}】まもなく掲載期間が終わります`, html, text };
}

// ── 6. 管理者による非公開 ──────────────────────────────────────────

export function listingSuspendedEmail(options: {
  title: string;
  reason: string;
  contactUrl: string;
}): EmailContent {
  const { html, text } = layout({
    heading: "投稿を非公開にしました",
    bodyHtml: `
      <p style="margin:0 0 12px">次の投稿を、利用規約に照らして非公開にしました。</p>
      <p style="margin:0 0 12px"><strong>${escapeHtml(options.title)}</strong></p>
      <p style="margin:0 0 12px">理由：${escapeHtml(options.reason)}</p>
      <p style="margin:0;font-size:13px;color:#6d6759">
        お心当たりがない場合や、内容についてご説明がある場合は、お問い合わせからご連絡ください。<br>
        掲載料の返金については、お問い合わせのうえ個別に対応します。
      </p>`,
    bodyText: [
      "次の投稿を、利用規約に照らして非公開にしました。",
      "",
      options.title,
      `理由：${options.reason}`,
      "",
      "お心当たりがない場合は、お問い合わせからご連絡ください。",
    ].join("\n"),
    actionUrl: options.contactUrl,
    actionLabel: "お問い合わせ",
  });

  return { subject: `【${SITE.name}】投稿を非公開にしました`, html, text };
}

// ── 7. アカウント削除の確認 ────────────────────────────────────────

export function accountDeletionEmail(options: {
  purgeDate: string;
  cancelUrl: string;
}): EmailContent {
  const { html, text } = layout({
    heading: "退会のお申し込みを受け付けました",
    bodyHtml: `
      <p style="margin:0 0 12px">${escapeHtml(options.purgeDate)}に、アカウントと投稿・メッセージを削除します。</p>
      <p style="margin:0 0 12px">それまではログインでき、下のリンクから取り消せます。</p>
      <p style="margin:0;font-size:13px;color:#6d6759">
        法令で保存が求められる決済の記録は、個人が特定できない形にしたうえで保管します。<br>
        削除後の復旧はできません。
      </p>`,
    bodyText: [
      `${options.purgeDate}に、アカウントと投稿・メッセージを削除します。`,
      "それまではログインでき、下のリンクから取り消せます。",
      "",
      "法令で保存が求められる決済の記録は、個人が特定できない形にしたうえで保管します。",
      "削除後の復旧はできません。",
    ].join("\n"),
    actionUrl: options.cancelUrl,
    actionLabel: "退会を取り消す",
  });

  return { subject: `【${SITE.name}】退会のお申し込みを受け付けました`, html, text };
}

/**
 * 運営者への警報。
 *
 * ★利用者へは送らない。★ 宛先は EMAIL_REPLY_TO（運営の窓口）。
 * 決済は成立したのに掲載が出ていない、返金したのに掲載が続いている、
 * といった「どちらの画面にもエラーが出ない壊れ方」を知らせる。
 * 件名を日本語にしていないのは、受信箱で絞り込みやすくするため。
 */
export function opsPaymentAlertEmail(options: {
  kind: "paid_not_published" | "refunded_but_live" | "failed_webhooks";
  listingTitle: string;
  listingStatus: string;
  adminUrl: string;
}): EmailContent {
  const heading =
    options.kind === "paid_not_published"
      ? "決済は成立したが掲載が出ていない"
      : options.kind === "refunded_but_live"
        ? "返金済みなのに掲載が続いている"
        : "処理できていない決済通知がある";
  const detail =
    options.kind === "paid_not_published"
      ? "利用者は110円を支払っていますが、投稿が公開されていません。Stripe 側は成功として終わっているため、放置すると利用者は払ったまま去ります。"
      : options.kind === "refunded_but_live"
        ? "全額返金済みの投稿が公開されたままです。返金したのに掲載が続いている状態で、決済事業者側にもアプリのエラーにも出ません。"
        : "Stripe からの通知を受け取ったのに処理を終えられていないものがあります。Stripe には 200 を返しているので再送されず、投稿側にも痕跡が残らない場合があります（決済記録の作成に失敗した Session など）。payment_webhook_events を確認してください。";

  const { html, text } = layout({
    heading,
    bodyHtml: `
      <p style="margin:0 0 12px">${escapeHtml(detail)}</p>
      <p style="margin:0 0 12px"><strong>${escapeHtml(options.listingTitle)}</strong><br>
      現在の状態: ${escapeHtml(options.listingStatus)}</p>
      <p style="margin:0;font-size:13px;color:#6d6759">
        この通知は同じ決済につき1回だけ送られます。対応しても再送はされません。
      </p>`,
    bodyText: [
      detail,
      "",
      options.listingTitle,
      `現在の状態: ${options.listingStatus}`,
      "",
      "この通知は同じ決済につき1回だけ送られます。",
    ].join("\n"),
    actionUrl: options.adminUrl,
    actionLabel: "決済状況を開く",
  });

  return { subject: `[nakadachi][ops] ${heading}`, html, text };
}

/**
 * 定期処理が落ちたことを知らせる（運営者宛）。
 *
 * ★ログに «failed» と出るだけでは、誰も気づかない。★
 * OPERATIONS.md には「件数ではなく failed になっていたらその処理は
 * 落ちている」と書いてあるが、それは★人が自発的にログを読んだとき★にしか
 * 働かない。とくに書き出し（バックアップ）は、Supabase Free に
 * PITR が無い以上これが唯一の備えで、落ちていることに気づくのが
 * 「戻したい」と思った日になると手遅れになる。
 */
export function opsCronAlertEmail(options: {
  failedTasks: string[];
  logsUrl: string;
}): EmailContent {
  const isBackup = options.failedTasks.includes("exportDatabase");
  const heading = isBackup
    ? "★バックアップの書き出しが落ちています★"
    : "定期処理が落ちています";

  const detail = isBackup
    ? "データベースの日次の書き出しに失敗しました。本番の DB（Supabase Free）には DB 側のバックアップも時点復旧もありません。★この書き出しが唯一の備えです。★ 落ちたままだと、復旧が必要になった日に使える写しがありません。"
    : "定期処理のいずれかが最後まで終わりませんでした。退会後の削除、発信者情報の削除、掲載の期限切れなど、利用者との約束に直結するものが含まれます。";

  const list = options.failedTasks.join("、");

  const { html, text } = layout({
    heading,
    bodyHtml: `
      <p style="margin:0 0 12px">${escapeHtml(detail)}</p>
      <p style="margin:0 0 12px">落ちた処理: <strong>${escapeHtml(list)}</strong></p>
      <p style="margin:0;font-size:13px;color:#6d6759">
        この通知は同じ処理につき1日1回だけ送られます。直すまで毎回は鳴りません。
      </p>`,
    bodyText: [
      detail,
      "",
      `落ちた処理: ${list}`,
      "",
      "この通知は同じ処理につき1日1回だけ送られます。",
    ].join("\n"),
    actionUrl: options.logsUrl,
    actionLabel: "ログを開く",
  });

  return { subject: `[nakadachi][ops] ${heading}`, html, text };
}

/**
 * お問い合わせフォームの転送（運営者宛）。
 *
 * ★以前は送っていなかった。★ 画面には「受け付けました。ご返信します」と
 * 出しながら、残るのは件名と本文の文字数だけで、本文は誰にも届かず
 * 復元もできなかった（2026-08-17 の点検で発覚）。詐欺の通報や法的な相談が
 * ここに来る。送れなかったときは画面にもそう出す（contact.tsx）。
 *
 * 本文は利用者の入力そのもの。★必ずエスケープする。★
 */
export function contactInboundEmail(options: {
  fromEmail: string;
  subject: string;
  body: string;
}): EmailContent {
  const { html, text } = layout({
    heading: "お問い合わせが届きました",
    bodyHtml: `
      <p style="margin:0 0 12px">差出人: ${escapeHtml(options.fromEmail)}<br>
      件名: ${escapeHtml(options.subject)}</p>
      <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-family:inherit;background:#f7f5ef;padding:12px;border-radius:8px">${escapeHtml(options.body)}</pre>
      <p style="margin:12px 0 0;font-size:13px;color:#6d6759">
        このメールにそのまま返信すると差出人へ届きます（Reply-To を差出人にしてあります）。
      </p>`,
    bodyText: [
      `差出人: ${options.fromEmail}`,
      `件名: ${options.subject}`,
      "",
      options.body,
      "",
      "このメールにそのまま返信すると差出人へ届きます。",
    ].join("\n"),
  });

  return { subject: `[nakadachi][問い合わせ] ${options.subject}`, html, text };
}
