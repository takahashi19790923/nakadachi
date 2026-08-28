import { Writable } from "node:stream";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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
    /*
     * ★-pooler を必須にしない。★ 本番は Supabase の Direct connection
     * （db.<ref>.supabase.co:5432、プーラーではない）で、Hyperdrive が
     * 接続を束ねる。以前のパターンは -pooler を要求していたので、
     * ★正しい本番の接続文字列を拒否した★（2026-08-25 の公開前監査で発覚）。
     * 障害の最中にこれに当たると、原因の分からない足止めになる。
     *
     * なお本番は通常 DATABASE_URL を持たない（Hyperdrive の binding を使う）。
     * ここへ入れるのは、退避路として直接繋ぐときだけ。
     */
    hint: "接続文字列（Supabase は Direct、Neon は pooled）",
    pattern: /^postgres(ql)?:\/\/\S+:\S+@\S+\/\S+/,
    shape: "postgresql://ユーザー:パスワード@ホスト:5432/データベース名",
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
    name: "ACCESS_LOG_KEY",
    hint: "発信者情報(IP)の暗号化鍵。32バイト base64url。上の2つとは別の値",
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

/**
 * 実際には投入しない練習用の指定。
 *
 * ★これが無かったせいで、入力の見え方を «実物で» 試して
 * preview の STRIPE_SECRET_KEY を偽の値で上書きした（2026-08-29）。★
 * 秘密を投入する道具に「試しに動かす」手段が無いと、試すこと自体が
 * 事故になる。--dry-run なら wrangler を呼ばない。
 */
const dryRun = args.includes("--dry-run");

/**
 * ★どこへ入れるのかを、入れる前に確かめる。★
 *
 * wrangler は「いま居るディレクトリ」の設定を読む。スクリプトの側は
 * それを知らないので、★別のリポジトリで走らせても素直に動く★。
 *
 * 2026-08-29、実際に別サービス（kigen-memo）の本番へ、なかだちの
 * Stripe テスト鍵を投入して稼働中の決済を壊した。画面には
 * 「Creating the secret for the Pages project "kigen-memo"」と出ていたが、
 * ★その行が流れるのは、値を入力し終えたあと★で、止める役には立たない。
 *
 * 原因は「cd を付け忘れた」ことだが、対策を「次から気をつける」に
 * 置かない。★道具の側が、行き先を先に見せて確かめる。★
 *
 * ★ここで防げる範囲を正確に言う。★ あの事故は «kigen-memo の中で
 * kigen-memo のスクリプトを走らせた» なので、なかだち側のこの検査は
 * 当時は働かない位置にある。塞げるのは「なかだちのスクリプトを
 * 別の場所で走らせる」ほう。★同じ検査を各サービスへ入れて初めて
 * 事故そのものが塞がる★（新サービス構築ルール.md に書く）。
 */
const EXPECTED_PROJECT = "nakadachi";

/** JSONC からコメントを外す。文字列の中の // と /* は落とさない */
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += c;
  }
  // 末尾コンマ（JSONC では書ける）を落とす
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** いま居るディレクトリの wrangler 設定を読む。無ければ null */
function readWranglerConfig() {
  for (const file of ["wrangler.jsonc", "wrangler.json"]) {
    try {
      const raw = readFileSync(file, "utf8");
      return { file, config: JSON.parse(stripJsonComments(raw)) };
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`${file} を読めませんでした: ${error.message}`, {
        cause: error,
      });
    }
  }
  return null;
}

const found = readWranglerConfig();

if (!found) {
  console.error("\n★ここは nakadachi のディレクトリではありません。★");
  console.error(`  いま居る場所: ${process.cwd()}`);
  console.error("  wrangler の設定ファイルが見つかりません。");
  console.error("  移動してから、もう一度実行してください:");
  console.error('    cd "C:\\Users\\htaka\\OneDrive\\ドキュメント\\Kimi\\Workspaces\\nakadachi"\n');
  process.exit(1);
}

const projectName = found.config?.name;

if (projectName !== EXPECTED_PROJECT) {
  /*
   * ★ここは «確認して続行» にしない。★ 押せる選択肢として出すと、
   * 急いでいる人は押す。実際に押した。行き先が違うなら、止める。
   */
  console.error("\n★別のプロジェクトのディレクトリで実行しています。★");
  console.error(`  ${found.file} のプロジェクト名: ${projectName ?? "(無し)"}`);
  console.error(`  このスクリプトが投入してよいのは: ${EXPECTED_PROJECT}`);
  console.error(`  いま居る場所: ${process.cwd()}`);
  console.error("\n  ★このまま進めると、別のサービスの秘密を上書きします。★");
  console.error("  なかだちのディレクトリへ移動してから実行してください。\n");
  process.exit(1);
}

const envConfig = found.config?.env?.[targetEnv];
if (!envConfig) {
  console.error(`\n★${targetEnv} という環境は ${found.file} にありません。★`);
  console.error(`  使えるのは: ${Object.keys(found.config?.env ?? {}).join(", ") || "(無し)"}\n`);
  process.exit(1);
}

/** wrangler へ値を渡す。改行を足さない */
function putSecret(name, value) {
  if (dryRun) {
    console.log(`  （--dry-run のため投入しません）`);
    return Promise.resolve();
  }
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

/**
 * 入力した値を画面に出さない。
 *
 * ★以前は «値は画面に表示されますが、コマンド履歴には残りません» と
 * 断って、そのまま表示していた。★ 履歴だけが問題ではない ——
 * 端末のスクロールバック、tmux や screen のバッファ、エディタの
 * 端末ペイン（保存されることがある）、画面共有、録画。
 * 本番の DB のパスワードや暗号化鍵が、そのどれにも平文で残る。
 *
 * 質問中だけ出力を飲み込み、打った文字は * で置き換える。
 * 貼り付け（複数文字が一度に来る）でも動く。
 */
function createHiddenInterface() {
  let hiding = false;

  /*
   * ★出力そのものを止める。★
   *
   * 一度 rl._writeToOutput を差し替えて * を出す形にしたが、
   * ★パイプ経由では効かず、値がそのまま画面に出た★（2026-08-29 に実測）。
   * 実行のされ方で漏れたり漏れなかったりする作りは、
   * «漏れない» と言えない。書き出し口を1つに絞って、そこを閉じる。
   *
   * 代わりに、Enter のあとで «受け取った文字数» を出す。
   * 最初は何も出さなかったので、貼り付けても画面が動かず
   * ★貼れたのか分からない★状態だった（実際にそう言われた）。
   * 見えない仕掛けは、使う人には «壊れている» と区別がつかない。
   */
  const muted = new Writable({
    write(chunk, _encoding, callback) {
      if (!hiding) process.stdout.write(chunk);
      callback();
    },
  });

  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });

  return {
    close: () => rl.close(),
    /** 値を画面に出さずに1行受け取る */
    async secret(text) {
      // プロンプトは自分で出す（readline 側は黙らせるため）。
      process.stdout.write(text);
      hiding = true;
      try {
        const answer = await rl.question("");
        process.stdout.write("\n");
        process.stdout.write(
          answer.length === 0
            ? "  （何も入力されていません → この項目は飛ばします）\n"
            : `  ✓ ${answer.length}文字を受け取りました（内容は表示しません）\n`,
        );
        return answer;
      } finally {
        hiding = false;
      }
    },
    /** 画面に出してよい質問（確認など） */
    question: (text) => rl.question(text),
  };
}
const rl = createHiddenInterface();

const items = only ? SECRETS.filter((s) => only.includes(s.name)) : SECRETS;

/*
 * ★行き先を、入力を受け取る前に見せる。★
 *
 * 事故のときに画面へ出ていた行き先は、値を入れ終えたあとに流れた。
 * 見せる位置が違うと、書いてあっても止まらない。
 *
 * 確認は y/N ではなく★環境名を打たせる★。preview と production は
 * 1つの取り違えで意味がまるで違う（片方は稼働中の決済に効く）。
 * y を押す動作は、どちらでも同じ動作になってしまう。
 */
console.log("\n──────── 投入先 ────────");
console.log(`  プロジェクト : ${projectName}`);
console.log(`  環境         : ${targetEnv}`);
console.log(`  公開URL      : ${envConfig.vars?.APP_ORIGIN ?? "(不明)"}`);
console.log(`  設定ファイル : ${found.file}`);
console.log(`  ディレクトリ : ${process.cwd()}`);
console.log(`  入れる項目   : ${items.map((s) => s.name).join(", ")}`);
console.log("────────────────────────");
if (dryRun) console.log("★--dry-run：実際には投入しません。★");

const typed = (
  await rl.question(`\nこの ${items.length} 項目を上へ入れます。よければ「${targetEnv}」と入力: `)
).trim();

if (typed !== targetEnv) {
  console.log(`\n中止しました（入力: ${typed === "" ? "(空)" : typed}）。何も変更していません。`);
  rl.close();
  process.exit(1);
}

console.log("");
console.log(`環境: ${targetEnv}${dryRun ? "（--dry-run：投入しません）" : ""}`);
console.log(`対象: ${items.length}項目${only ? "（--only で絞り込み）" : ""}`);
console.log("空のまま Enter を押すと、その項目は飛ばします。");
console.log(
  "★入力した値は画面に表示されません。★ 貼り付けても画面は動きませんが、\n" +
    "  ちゃんと入っています。貼ったら Enter を押してください。\n" +
    "  Enter のあとに «何文字受け取ったか» が出ます。\n",
);

for (const secret of items) {
  let value;
  for (;;) {
    value = (await rl.secret(`${secret.name}（${secret.hint}）: `)).trim();
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
