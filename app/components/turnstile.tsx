import { useEffect, useRef } from "react";

import { TURNSTILE_CONTAINER_ID, TURNSTILE_FIELD } from "~/domain/form-fields";

/**
 * Cloudflare Turnstile の枠。
 *
 * ★暗黙レンダリング（class="cf-turnstile"）は使えない。★
 * api.js は読み込まれた時点で1回だけ自動描画する。この構成では、
 *   1. サーバー描画の HTML に箱がある
 *   2. api.js が箱を見つけて iframe を差し込む
 *   3. React がハイドレーションで DOM を突き合わせ、React が知らない
 *      子要素（差し込まれた iframe）を取り除く
 * となり、★箱は残るが中身が空★になる。画面には何も出ず、エラーも出ない。
 * さらに画面遷移でこのページへ来た場合は api.js 自体が再実行されないので、
 * 直リンクでは出るのにリンク経由では出ない、という形にもなる。
 *
 * そのため明示レンダリング（render=explicit ＋ turnstile.render）を使う。
 * 描画の時期を React 側が持つので、上のどちらも起きない。
 *
 * ★箱の id に "turnstile" を使わないこと。★ 詳細は domain/form-fields.ts。
 */

const SCRIPT_ID = "cf-turnstile-api";
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      language?: string;
      theme?: string;
      "response-field-name"?: string;
    },
  ) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** api.js を1回だけ読む。画面遷移で戻ってきたときは既存のものを使う */
function loadApi(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);

  return new Promise((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID);
    const script =
      existing instanceof HTMLScriptElement
        ? existing
        : Object.assign(document.createElement("script"), {
            id: SCRIPT_ID,
            src: SCRIPT_SRC,
            async: true,
            defer: true,
          });

    const done = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("turnstile api did not initialise"));
    };

    script.addEventListener("load", done, { once: true });
    script.addEventListener(
      "error",
      () => { reject(new Error("turnstile api failed to load")); },
      { once: true },
    );

    if (!existing) document.head.appendChild(script);
    // 既に読み込み済みの <script> に後から load を張っても発火しないので、
    // その場合は window.turnstile の有無で判断する。
    else if (window.turnstile) done();
  });
}

export function TurnstileWidget({ siteKey }: { siteKey: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!siteKey) return;

    let widgetId: string | null = null;
    let cancelled = false;

    loadApi()
      .then((api) => {
        if (cancelled || !ref.current) return;
        // 既に描いてあるなら二重に描かない（開発時の二重実行対策）。
        if (ref.current.childElementCount > 0) return;
        widgetId = api.render(ref.current, {
          sitekey: siteKey,
          language: "ja",
          theme: "light",
          "response-field-name": TURNSTILE_FIELD,
        });
      })
      .catch(() => {
        // ★黙って通さない。★ サーバー側は fail-close なので送信は 503 になるが、
        // 利用者には「押しても何も起きない」に見える。理由を出す。
        if (!cancelled && ref.current) {
          ref.current.textContent =
            "確認の読み込みに失敗しました。通信環境をご確認のうえ、再読み込みしてください。";
          ref.current.className =
            "mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800";
        }
      });

    return () => {
      cancelled = true;
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [siteKey]);

  if (!siteKey) {
    // ★サイトキーが空なら、動いていてもボット対策は効いていない。★
    // 画面に何も出さずに黙って通すのではなく、運用者が気づけるようにする
    // （サーバー側は fail-close なので、この状態では送信自体が 503 になる）。
    return (
      <p className="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
        認証の設定が完了していません。時間をおいてお試しください。
      </p>
    );
  }

  return <div ref={ref} id={TURNSTILE_CONTAINER_ID} className="mt-4" />;
}
