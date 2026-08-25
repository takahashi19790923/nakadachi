import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

/**
 * コミット前の秘密情報チェック。
 *
 *   node scripts/check-secrets.mjs            1回だけ確認する
 *   node scripts/check-secrets.mjs --build    ビルド成果物を見る（配信される側）
 *   node scripts/check-secrets.mjs --install  git の pre-commit フックとして入れる
 *
 * GitHub の Secret Scanning と Push Protection が第一の防御。これは
 * ★手元で気づけるようにするための補助★で、独自の形式（セッション署名鍵など）
 * も見る。
 *
 * ★見つかったら、消して終わりにしないこと。★ 一度でも push した値は
 * 漏れたものとして扱い、SECURITY.md のローテーション手順に従う。
 */

/** 本物らしい値の形。ダミー（REPLACE_ME…）には当たらない */
const PATTERNS = [
  { name: "Stripe の本番シークレット", re: /sk_live_[0-9a-zA-Z]{20,}/ },
  { name: "Stripe の制限付きキー", re: /rk_live_[0-9a-zA-Z]{20,}/ },
  { name: "Stripe のテストシークレット", re: /sk_test_[0-9a-zA-Z]{20,}/ },
  { name: "Stripe の Webhook シークレット", re: /whsec_[0-9a-zA-Z]{24,}/ },
  { name: "Resend の API キー", re: /\bre_[0-9A-Za-z_-]{20,}/ },
  { name: "Cloudflare の API トークン", re: /\b[A-Za-z0-9_-]{40}\b(?=.*cloudflare)/i },
  {
    /*
     * ★事業者名で絞らない。★ 以前は `\.neon\.tech` で終わっていて、
     * 2026-08-18 に本番を Supabase へ移した時点から、★本番の接続文字列が
     * この検査を素通りするようになっていた★（2026-08-25 の公開前監査で発覚）。
     * DB の引っ越しのたびに検査を直す作りにしない。
     *
     * ローカルだけに向いたものと、書式見本は除く。鳴りっぱなしにすると
     * 本当の混入まで «またあれか» で流される。
     *
     * ★パスワード部に < > を含むものは手順書の穴埋め。★
     * 実物の URL では山括弧はパーセント符号化されるので、生で入っていれば
     * `<新しいパスワード>` のような見本と判断してよい。
     */
    name: "データベースの接続文字列（パスワード付き）",
    re: /postgres(?:ql)?:\/\/[^:\s]+:[^@\s<>]{8,}@(?!127\.0\.0\.1|localhost|host\.docker|\.\.\.)[^/\s]+/,
  },
  { name: "秘密鍵", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

/** 追跡してはいけないファイル */
const FORBIDDEN_FILES = /^(\.env|\.dev\.vars)($|\.)(?!example)/;

if (process.argv.includes("--install")) {
  installHook();
  process.exit(0);
}

if (process.argv.includes("--build")) {
  checkBuildOutput();
  process.exit(0);
}

const staged = gitOutput("git diff --cached --name-only --diff-filter=ACM")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

// ステージが空なら、追跡中のファイル全体を見る（単発の確認用）。
const targets =
  staged.length > 0
    ? staged
    : gitOutput("git ls-files").split("\n").map((l) => l.trim()).filter(Boolean);

const problems = [];

for (const file of targets) {
  if (FORBIDDEN_FILES.test(file)) {
    problems.push(`${file}: 秘密情報のファイルが追跡対象になっています`);
    continue;
  }
  if (file.endsWith(".example")) continue;
  if (file.startsWith("scripts/check-secrets")) continue;

  let contents;
  try {
    contents =
      staged.length > 0
        ? gitOutput(`git show :${JSON.stringify(file)}`)
        : gitOutput(`git show HEAD:${JSON.stringify(file)}`);
  } catch {
    continue; // バイナリや新規ファイルは飛ばす
  }

  /*
   * ★DB の写しは名前ではなく «形» で止める。★
   *
   * 2026-08-26、復旧の練習で R2 から落とした写しが `restore.json` として
   * リポジトリ直下に置かれ、`git status` に `??` で並んだ。
   * ★`git add -A` を1回打てば、本番の個人情報が全部 public リポジトリに
   * 入るところだった。★ .gitignore にも名前を足したが、名前は変えられる
   * （`data.json`、`x.json`、拡張子なし）。中身で判定する。
   *
   * backup-service.server.ts が作る形（version + exportedAt + tables[]）に
   * 当てる。写しは 70KB 以上あるので、先頭だけ見れば足りる。
   */
  const head = contents.slice(0, 400);
  if (
    /"version"\s*:\s*1/.test(head) &&
    /"exportedAt"\s*:/.test(head) &&
    /"tables"\s*:\s*\[/.test(head)
  ) {
    problems.push(
      `${file}: ★データベースの写しです。★ 利用者の投稿・メッセージ・` +
        `暗号化済みメールアドレス・決済記録・復号できるIPアドレスが入っています。` +
        `db-backup/ へ移してください（このリポジトリは public です）`,
    );
    continue;
  }

  for (const pattern of PATTERNS) {
    if (pattern.re.test(contents)) {
      problems.push(`${file}: ${pattern.name} らしき文字列があります`);
    }
  }
}

if (problems.length > 0) {
  console.error("\n秘密情報らしきものが見つかりました:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\n★消して終わりにしないでください。★ 一度でも push した値は漏れたものとして扱い、",
  );
  console.error("SECURITY.md の「秘密情報のローテーション手順」に従ってください。\n");
  process.exit(1);
}

console.log("秘密情報らしき文字列は見つかりませんでした。");

/**
 * ビルド成果物を見る。
 *
 * ★git の検査だけでは足りない。★ 秘密はソースに書かれていなくても、
 * 束ねる過程でクライアント側へ紛れ込むことがある（サーバー専用のはずの
 * モジュールを、うっかりコンポーネントから import したときなど）。
 * 見えるのは配信後なので、配信前にここで止める。
 *
 * ★build/server/.dev.vars は Cloudflare の Vite プラグインが作るコピー。★
 * ローカルの preview/E2E がこれを読む。配信されるのは build/client だけなので
 * 存在自体は問題ないが、build/client 側に同じ値が出ていたら重大。
 */
function checkBuildOutput() {
  const publicDir = "build/client";
  if (!existsSync(publicDir)) {
    console.error(`${publicDir} がありません。先に pnpm run build を実行してください。`);
    process.exit(1);
  }

  // .dev.vars の実値そのものが配信物に出ていないか（形式に頼らない照合）
  const literals = [];
  if (existsSync(".dev.vars")) {
    for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const value = trimmed.slice(trimmed.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
      // 短い値は偶然一致する。TURNSTILE のテスト鍵は公開値なので除く。
      if (value.length >= 16 && !value.startsWith("1x000000")) {
        literals.push({ name: trimmed.slice(0, trimmed.indexOf("=")), value });
      }
    }
  }

  const found = [];
  for (const file of walk(publicDir)) {
    let contents;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const pattern of PATTERNS) {
      if (pattern.re.test(contents)) found.push(`${file}: ${pattern.name}`);
    }
    for (const literal of literals) {
      if (contents.includes(literal.value)) {
        found.push(`${file}: .dev.vars の ${literal.name} の値`);
      }
    }
  }

  if (found.length > 0) {
    console.error("\n★配信される成果物に秘密情報が入っています。★\n");
    for (const item of found) console.error(`  - ${item}`);
    console.error(
      "\nサーバー専用のモジュールがクライアント側から参照されていないか確認してください。",
    );
    console.error("既に配信済みなら、漏れたものとして扱いローテーションしてください。\n");
    process.exit(1);
  }

  console.log(
    `${publicDir} に秘密情報は見つかりませんでした（.dev.vars の ${literals.length}項目と照合）。`,
  );
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function gitOutput(command) {
  return execSync(command, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function installHook() {
  const dir = ".git/hooks";
  if (!existsSync(".git")) {
    console.error("git リポジトリではありません。先に git init してください。");
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/pre-commit`;
  writeFileSync(
    path,
    `#!/bin/sh\n# nakadachi: コミット前の秘密情報チェック\nnode scripts/check-secrets.mjs || exit 1\n`,
    "utf8",
  );
  try {
    chmodSync(path, 0o755);
  } catch {
    // Windows では実行権限の概念が無い。git が扱うので問題ない。
  }
  console.log(`${path} を作成しました。`);
}
