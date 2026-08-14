import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

/**
 * Cloudflare Workers の Secret を投入する。
 *
 *   pnpm run secrets:put -- --env preview
 *
 * ★PowerShell のパイプで渡さないこと。★
 *   "abc" | npx wrangler secret put X
 * が実際に渡すのは、先頭に BOM（U+FEFF）が付き末尾が CRLF になった値。
 * ここで文字そのものを書かずエスケープで示しているのは、
 * この注釈自体に BOM を混ぜないため。
 * DB の接続文字列なら接続エラーで露見するが、★API キーは黙って
 * 認証エラーになるだけで気づけない★。
 *
 * ここでは child_process.spawn で stdin へ直接書き込む（改行を足さない）。
 */

/*
 * pattern は「その項目に別の秘密を貼ってしまった」を捕まえるためのもの。
 * ★実際に起きた事故。★ 1つずれて DATABASE_URL に API キーを入れると、
 * wrangler は素直に受け取り「Uploaded secret」と言う。気づけるのは
 * 次のデプロイのあと、画面が 503 になってからになる。
 * 形が違えば入り口で止める。
 */
const SECRETS = [
  {
    name: "DATABASE_URL",
    hint: "Neon の pooled 接続文字列（-pooler 付き）",
    pattern: /^postgres(ql)?:\/\/\S+@\S+-pooler\.\S+\/\S+/,
    shape: "postgresql://ユーザー:パスワード@...-pooler.../データベース名",
  },
  {
    name: "SESSION_SECRET",
    hint: "48バイトのランダム文字列（base64url）",
    pattern: /^[A-Za-z0-9_-]{32,}$/,
    shape: "base64url の32文字以上",
  },
  {
    name: "EMAIL_ENCRYPTION_KEY",
    hint: "32バイト base64url（AES-GCM 用）",
    pattern: /^[A-Za-z0-9_-]{43}$/,
    shape: "base64url の43文字（32バイト）",
  },
  {
    name: "EMAIL_INDEX_KEY",
    hint: "32バイト base64url（HMAC 索引用。上とは別の値）",
    pattern: /^[A-Za-z0-9_-]{43}$/,
    shape: "base64url の43文字（32バイト）",
  },
  {
    name: "RESEND_API_KEY",
    hint: "Resend の API キー",
    pattern: /^re_[A-Za-z0-9_-]{20,}$/,
    shape: "re_ で始まる",
  },
  {
    name: "STRIPE_SECRET_KEY",
    hint: "Stripe のシークレットキー（テスト/本番を確認）",
    pattern: /^(sk|rk)_(test|live)_[A-Za-z0-9]{20,}$/,
    shape: "sk_test_ / sk_live_ で始まる",
  },
  {
    name: "STRIPE_WEBHOOK_SECRET",
    hint: "Stripe の Webhook 署名シークレット",
    pattern: /^whsec_[A-Za-z0-9]{20,}$/,
    shape: "whsec_ で始まる",
  },
  {
    name: "TURNSTILE_SECRET_KEY",
    hint: "共有ウィジェット rewrite-co-common のシークレット",
    pattern: /^0x[A-Za-z0-9_-]{20,}$/,
    shape: "0x で始まる（サイトキーと間違えないこと）",
  },
  { name: "ADMIN_BASIC_AUTH_USER", hint: "管理画面 第3層の利用者名（全プロジェクト共通）" },
  { name: "ADMIN_BASIC_AUTH_PASS", hint: "管理画面 第3層のパスワード（全プロジェクト共通）" },
];

const args = process.argv.slice(2);
const envIndex = args.indexOf("--env");
const targetEnv = envIndex >= 0 ? args[envIndex + 1] : null;

if (!targetEnv) {
  console.error("使い方: pnpm run secrets:put -- --env <preview|production> [--only A,B]");
  process.exit(1);
}

/*
 * --only で項目を絞る。10個ぶん Enter を押す作業を無くすため。
 * ★押す回数が多いほど、1つずれて別の値を入れる事故が起きやすい。★
 */
const onlyIndex = args.indexOf("--only");
const only =
  onlyIndex >= 0 && args[onlyIndex + 1]
    ? /*
       * ★カンマと空白の両方で区切れるようにする。★
       * PowerShell は引用符の無いカンマ区切りを「配列」と解釈し、
       * ネイティブコマンドへ渡すときに空白でつないでしまう。
       *   --only A,B  →  実際に届くのは "A B"
       * 手順書に書いたコマンドが Windows でだけ動かない、という事故になる。
       */
      args[onlyIndex + 1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    : null;

if (only) {
  const unknown = only.filter((n) => !SECRETS.some((s) => s.name === n));
  if (unknown.length > 0) {
    console.error(`知らない項目です: ${unknown.join(", ")}`);
    console.error(`使えるのは: ${SECRETS.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }
}

/** wrangler へ値を渡す。改行を足さない */
function putSecret(name, value) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["exec", "wrangler", "secret", "put", name, "--env", targetEnv],
      { stdio: ["pipe", "inherit", "inherit"], shell: process.platform === "win32" },
    );
    child.stdin.write(value);
    child.stdin.end();
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler secret put ${name} が終了コード ${code} で終了しました`));
    });
    child.on("error", reject);
  });
}

/**
 * Turnstile のシークレットを実際に問い合わせて確かめる。
 *
 * ★形では見分けられない。★ サイトキーもシークレットも `0x4AAAAAAA` で始まる。
 * 取り違えると siteverify が常に失敗し、画面には「確認に失敗しました」としか
 * 出ないまま全員がログインできなくなる（共通ルール §14 に記録あり）。
 *
 * ダミーのトークンを送ると、鍵が正しければ「トークンが不正」と返る。
 * 鍵が違えば「シークレットが不正」と返る。ここで判別できる。
 */
async function verifyTurnstileSecret(value) {
  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `secret=${encodeURIComponent(value)}&response=dummy`,
      },
    );
    const data = await response.json();
    const codes = data["error-codes"] ?? [];
    if (codes.includes("invalid-input-secret")) {
      return "Cloudflare が「シークレットが不正」と答えました。サイトキーを貼っていませんか？";
    }
    return null; // invalid-input-response なら鍵は正しい
  } catch {
    // 通信できないだけなら止めない（オフラインでも投入はできるべき）
    console.log("  （確認のための通信ができませんでした。投入は続けます）");
    return null;
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

const items = only ? SECRETS.filter((s) => only.includes(s.name)) : SECRETS;

console.log(`環境: ${targetEnv}`);
console.log(`対象: ${items.length}項目${only ? "（--only で絞り込み）" : ""}`);
console.log("空のまま Enter を押すと、その項目は飛ばします。");
console.log("★値は画面に表示されますが、コマンド履歴には残りません。★\n");

for (const secret of items) {
  let value;
  for (;;) {
    value = (await rl.question(`${secret.name}（${secret.hint}）: `)).trim();
    if (value === "") break;

    // ★形が違うものは入り口で止める。★ 1つずれて別の秘密を貼る事故を防ぐ。
    if (secret.pattern && !secret.pattern.test(value)) {
      console.log(`  ✗ 形が違います（期待: ${secret.shape}）`);
      console.log("    別の項目の値を貼っていませんか？ もう一度入力するか、空 Enter で飛ばしてください。");
      continue;
    }

    if (secret.name === "TURNSTILE_SECRET_KEY") {
      const problem = await verifyTurnstileSecret(value);
      if (problem) {
        console.log(`  ✗ ${problem}`);
        continue;
      }
      console.log("  ✓ Cloudflare に問い合わせて、鍵が有効であることを確認しました");
    }
    break;
  }

  if (value === "") {
    console.log("  → 飛ばしました\n");
    continue;
  }
  await putSecret(secret.name, value);
  console.log("");
}

rl.close();

console.log("投入が終わりました。");
console.log("");
console.log("★「Uploaded secret」は「正しい値が入った」を意味しません。★");
console.log("必ず実物で疎通を確認してください:");
console.log("  - DB          : /api/health が 200 を返すか（5回ではなく10回）");
console.log("  - Turnstile   : 実際にログインフォームを送信してみる");
console.log("  - Stripe      : テストモードで110円の決済を1回通す");
console.log("  - 設定の反映   : /api/config で secretsConfigured を確認する");
