# なかだち（NAKADACHI）

地域を選んで、ものの売り買い・ゆずりあい・貸し借り・手伝い・お仕事を掲載・閲覧できる、
日本国内向けのクラシファイド／マーケットプレイスです。

- **閲覧と会員登録は無料**
- **掲載時のみ、1件あたり110円（税込）**
- 成約手数料・月額料金はありません。自動更新・自動課金もしません
- 広告枠はありません

> **ブランド名は仮称です。** `app/config/site.ts` の1か所に集約してあるので、
> 表示名の変更はそこだけで済みます。Cloudflare のプロジェクト名とサブドメイン
> （`nakadachi`）を変える場合は、DEPLOYMENT.md の手順で付け替えてください。

---

## 目次

- [できること](#できること)
- [技術構成](#技術構成)
- [セットアップ](#セットアップ)
- [開発](#開発)
- [テスト](#テスト)
- [デプロイ](#デプロイ)
- [人間が用意するもの](#人間が用意するもの)
- [本番公開前チェックリスト](#本番公開前チェックリスト)
- [文書一覧](#文書一覧)

---

## できること

| 区分 | 内容 |
|---|---|
| カテゴリ | 売ります・買います／あげます・譲ります／貸します／手伝います・教えます／お仕事 |
| 検索 | 都道府県・市区町村・カテゴリ・投稿種別・価格帯・キーワード・並べ替え |
| 認証 | パスワードレス（メールの確認コードまたはリンク） |
| 投稿 | 下書き → 確認 → 110円の決済 → 公開。写真は最大10枚 |
| やり取り | 投稿単位のサイト内メッセージ、通報、ブロック、お気に入り |
| 管理 | 投稿の公開／非公開、利用停止、通報対応、返金、監査ログ、禁止ワード |

「貸します」は不動産だけでなく、電動ドライバー・脚立・アウトドア用品など、
たまにしか使わない日常品も対象にしています。
**デポジット（保証金）はサービスでは預かりません。** 条件を表示するだけです。

---

## 技術構成

| 用途 | 採用 | 版 |
|---|---|---|
| 実行環境 | Cloudflare Workers | compatibility_date 2026-08-13 / `nodejs_compat` |
| フレームワーク | React Router（framework mode, SSR） | 8.3.0 |
| ビルド | Vite + `@cloudflare/vite-plugin` | 8.2.1 / 1.52.0 |
| DB | Neon PostgreSQL。本番・preview は **Cloudflare Hyperdrive 経由**（`pg` 8.23）、ローカル・テストは `@neondatabase/serverless` 1.1.0 で直接 | — |
| ORM | Drizzle ORM / drizzle-kit | 0.45.2 / 0.31.10 |
| 写真 | Cloudflare R2（binding 経由） | — |
| メール | Resend（HTTP API） | — |
| 決済 | Stripe Checkout（HTTP API） | — |
| スタイル | Tailwind CSS | 4.3.3 |
| 検証 | Zod | 4.4.3 |
| テスト | Vitest / Playwright | 4.1.10 / 1.62.1 |
| パッケージ管理 | pnpm | 11.21.0 |

選定の理由と、依頼から外した判断は [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) §1 にあります。
構成の詳細は [ARCHITECTURE.md](ARCHITECTURE.md)。

**Node は 24 以上が必要です**（React Router 8 のビルド要件）。

---

## セットアップ

### 1. pnpm を用意する

```bash
npm install -g pnpm@11.21.0
```

corepack を使う場合は `corepack enable pnpm` でも構いませんが、
Windows では `C:\Program Files\nodejs` への書き込み権限が要ります。

### 2. 依存を入れる

```bash
pnpm install
```

`pnpm-lock.yaml` はコミットされています。`--frozen-lockfile` で再現できます。

### 3. ローカル用の設定ファイルを作る

```bash
node scripts/dev-setup.mjs
```

`.dev.vars` が無ければ、ローカル専用のダミー鍵を書き出します。
**既にあるファイルは上書きしません。**

`.dev.vars` も `.env` も `.gitignore` 済みです。
**このリポジトリに本物の値を書かないでください。**

### 4. Neon プロジェクトを作る

1. [Neon](https://neon.tech/) でプロジェクトを作る
2. データベースを3つに分ける
   - 開発用（`nakadachi_dev`）
   - preview 用（`nakadachi_preview`）
   - 本番用（`nakadachi`）
3. **pooled connection**（ホスト名に `-pooler` が入るほう）の接続文字列を控える
   - Workers は接続数が読めないため、本番では必ず pooled を使う
4. アプリが実行時に使うロールには **DDL 権限を与えない**（SECURITY.md 参照）

```bash
cp .env.example .env
```

Neon の接続文字列は **データベース名以外はすべて同じ** です。Connect 画面から
1つコピーし、末尾の DB 名だけ差し替えて 3 つ作ります。

| 変数 | データベース |
|---|---|
| `DATABASE_URL_DEV` | `nakadachi_dev` |
| `DATABASE_URL_PREVIEW` | `nakadachi_preview` |
| `DATABASE_URL_PRODUCTION` | `nakadachi` |
| `DATABASE_URL` | drizzle-kit 用。dev と同じ |

`.dev.vars` にも `DATABASE_URL`（dev）を書きます。こちらはアプリ本体が読みます。

> **必ず pooled を使ってください**（ホスト名に `-pooler` が入っているもの）。
> Workers は接続数を制御できないため、直接接続だと上限に当たります。
> pooled でない値を書くとスクリプトが起動時に落ちます。

### 5. マイグレーションと初期データ

```bash
pnpm run db:migrate            # dev
pnpm run db:seed               # dev
```

接続先は引数で明示します。省略すると dev です。

```bash
pnpm run db:migrate preview
pnpm run db:seed preview
pnpm run db:migrate production   # 確認を求められます
```

**環境の取り違えは仕組みで止めています。** `DATABASE_URL_PREVIEW` に本番の
接続文字列を貼っても、URL 内の DB 名と変数名が一致しないため起動時に落ちます。
`production` を指定したときだけ、`production` と入力させる確認が入ります
（CI では `--yes`）。

`db:migrate` は `pg_trgm` の有効化を含みます（キーワード検索に必要）。
`db:seed` は 47都道府県・主要市区町村・5カテゴリ・禁止ワードの初期値を入れます。
**何度流しても同じ結果になります**（既存の行は更新し、消しません）。

### 6. R2 バケットを作る

```bash
pnpm exec wrangler r2 bucket create nakadachi-media-dev
pnpm exec wrangler r2 bucket create nakadachi-media-preview
pnpm exec wrangler r2 bucket create nakadachi-media
```

binding は `wrangler.jsonc` に定義済み（`MEDIA`）です。
**R2 のアクセスキーは発行しません。** binding 経由でしか触りません。

### 7. Resend の送信ドメイン認証

1. Resend で `rewrite-co.com` を登録する
2. 表示された SPF / DKIM / DMARC の DNS レコードを Cloudflare のゾーンへ追加する
3. 認証が通るまで待つ（通常10〜30分）

送信元は `wrangler.jsonc` の `MAIL_FROM` で設定しています。

### 8. Stripe（テストモード）

1. **このサービス専用の Stripe アカウント**を作る
   （既存のアカウントを流用しない。Webhook が他サービスの決済まで拾うため）
2. テストモードであることを確認する
3. Webhook エンドポイントを登録する
   - URL: `https://<環境のドメイン>/api/stripe/webhook`
   - 購読するイベント:
     - `checkout.session.completed`
     - `checkout.session.async_payment_succeeded`
     - `checkout.session.async_payment_failed`
     - `checkout.session.expired`
     - `charge.refunded`
     - `refund.created`
     - `refund.updated`
     - `charge.dispute.created`
4. 署名シークレット（`whsec_…`）を控える

> `charge.refunded` は購読していても届かないことがあります。
> `refund.*` も併せて購読し、**どれか1つでも届けば止まる**ようにしてあります。

#### Managed Payments について

Checkout Session を作るとき `managed_payments[enabled]=false` を必ず送っています
（`stripe-client.server.ts`）。これが無いと
`Invalid line_items[0]: the product tax code is missing` で 400 になります。

★ここで税コードを足して回避してはいけません。★ エラーは消えますが、
Stripe が販売者（Merchant of Record）のままになり、消費税の納税義務も
Stripe 側へ移ります。当サービスは規約・特商法表記で「取引の当事者ではない、
場を提供するだけ」と書いているので、実態と食い違います。

**このアカウントには「Managed Payments を無効にする」設定はありません**
（2026-08-16 実測）。設定 → Managed Payments は
「使ってみる（取引ごとに 3.5% の追加手数料）」という加入を勧める案内で、
未開始の状態です。切るスイッチを探す必要はありません。コード側だけで足ります。

### 8.1 本番モードへ切り替えるとき

**2026-08-16 時点で、本番はまだ有効化されていません。** テストモードのみ動作します。
`/api/config` の `secretsConfigured.stripe` が `false` なのはこのためです。

ダッシュボード右上の「本番環境に切り替える」を押すと有効化ウィザードが開きます。
残っている項目は次のとおりです（それ以外は入力済み）。

- ビジネスの確認 → **割賦販売法に関する質問**（特商法違反・消費者契約法違反の有無）
- オプションを追加
- 確認して送信

> ⚠ 法人情報は**他の Stripe アカウントと共有**です
> （ウィザードに「この法人に変更を加えると、それを使用するすべてのアカウントが
> 更新されます」と表示されます）。ここでの変更は他サービスにも及びます。

有効化が通ったあとの手順:

1. 本番モードで Webhook 送信先を作る
   （URL は `https://nakadachi.rewrite-co.com/api/stripe/webhook`、イベントは §8 と同じ8件）
2. 本番の `sk_live_…` と、1で発行された `whsec_…` を投入する

   ```bash
   pnpm run secrets:put -- --env production --only STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET
   ```

   値はプロンプトに貼り付けます。**コマンドラインに直接書かないでください**
   （PowerShell の履歴に平文で残ります）。

   > ★`wrangler secret put` を直接使わないこと。★ 理由が2つある。
   >
   > 1. **`--env production` を付け忘れると別の Worker に入る。** この
   >    リポジトリの Worker 名は `nakadachi` だが、実際に動いているのは
   >    `nakadachi-production` / `nakadachi-preview`。省略すると
   >    どこにも使われない `nakadachi` へ入り、`/api/config` は
   >    `false` のまま。エラーも出ないので原因を追いにくい。
   > 2. **貼り間違いを形で弾けない。** 上のスクリプトは `sk_live_` /
   >    `whsec_` の形を検査してから投入する。項目が1つずれても
   >    wrangler は素直に受け取り「Uploaded secret」と言う。
   >
   > どうしても直接使うなら `--env production` を必ず付ける。
   > ★PowerShell のパイプで値を渡さないこと。★ BOM と CRLF が混ざる。
3. `curl https://nakadachi.rewrite-co.com/api/config` で
   `"stripe":true,"stripeWebhook":true` を確認する
4. 本番で110円の決済を1回通し、公開されることを確認する

> サンドボックスの Webhook 送信先（preview 向け）はそのままで構いません。
> ★消す必要があるのは「サンドボックスの送信先が本番URLを向いている」場合だけ★です。
> その構成だと、テスト鍵を知っている人がテストカードで本番へ正規の署名付き通知を
> 送れてしまい、署名検証では止められません。現在は preview を向いているので問題ありません。

### 9. Secret を投入する

```bash
pnpm run secrets:put -- --env preview
pnpm run secrets:put -- --env production
```

対話で1項目ずつ入力します。**値はコマンド履歴に残りません。**

> **PowerShell のパイプで渡さないでください。**
> `"abc" | wrangler secret put X` が実際に渡すのは `"﻿abc\r\n"`
> （先頭に BOM、末尾に CRLF）です。接続文字列なら接続エラーで露見しますが、
> **API キーは黙って認証エラーになるだけ**で気づけません。

投入する10項目：

| 名前 | 用途 |
|---|---|
| `DATABASE_URL` | Neon の pooled 接続文字列。★本番・preview では Hyperdrive の binding があれば使われない★（無いときの退避路。DEPLOYMENT.md「Hyperdrive」） |
| `SESSION_SECRET` | セッションと CSRF トークンの署名鍵 |
| `EMAIL_ENCRYPTION_KEY` | メールアドレスの暗号化（32バイト base64url） |
| `EMAIL_INDEX_KEY` | メールアドレスの検索索引（**上とは別の値**） |
| `RESEND_API_KEY` | メール送信 |
| `STRIPE_SECRET_KEY` | 決済 |
| `STRIPE_WEBHOOK_SECRET` | Webhook の署名検証 |
| `TURNSTILE_SECRET_KEY` | ボット対策（共有ウィジェットのもの） |
| `ADMIN_BASIC_AUTH_USER` | 管理画面 第3層（全プロジェクト共通） |
| `ADMIN_BASIC_AUTH_PASS` | 同上 |

投入後、**必ず実物で疎通を確認してください**。
「Uploaded secret」は「正しい値が入った」を意味しません。

```bash
curl.exe -s https://<ホスト>/api/config
curl.exe -s https://<ホスト>/api/health
```

### 10. GitHub の設定

リポジトリの Settings で有効にします。

1. **Secret Scanning**: Settings → Code security → Secret scanning → Enable
2. **Push Protection**: 同じ画面の Push protection → Enable
   - 秘密情報を含むコミットの push 自体が止まります
3. **Dependabot**: `.github/dependabot.yml` があるので自動で動きます
4. **CodeQL**: `.github/workflows/codeql.yml` があるので自動で動きます

**コミット前の確認**を手元でも動かす場合：

```bash
node scripts/check-secrets.mjs           # 1回だけ確認する
node scripts/check-secrets.mjs --install # git の pre-commit フックとして入れる
```

### 11. 管理者を作る

```bash
pnpm run admin:create preview     # 接続先を明示する。省略すると dev
```

対話でメールアドレスを聞かれます（運営者本人のアドレス）。
**引数で渡さないでください。** PowerShell の履歴に残ります。

`.env` の `EMAIL_ENCRYPTION_KEY` / `EMAIL_INDEX_KEY` は、
**その環境に投入したものと同じ値**である必要があります。違うと索引が
一致せず、作った管理者でログインできません。

作成後の流れ：
1. 通常のログイン画面でメールの確認コードを受け取る
2. `/admin/gate` で、もう一度メールの確認コードと、追加の資格情報を入力する
3. 管理画面に入れる

---

## 開発

```bash
pnpm run dev          # http://localhost:5273
```

DB を使わない画面（規約・ログイン・お問い合わせ）は `DATABASE_URL` なしで動きます。
投稿の一覧・詳細・マイページを触るには、`.dev.vars` に開発用の接続文字列が要ります。

> **`.dev.vars` を書き換えたら再ビルドしてください。**
> Cloudflare の Vite プラグインはビルド時に `.dev.vars` を
> `build/server/.dev.vars` へコピーします。`vite preview` が読むのはこのコピーです。
> 再ビルドせずに preview を起動すると、**古い値のまま**動きます。
> パスワードを入れ替えた直後だと `password authentication failed` が出るため、
> 接続文字列を疑って時間を溶かします。`pnpm run preview`（ビルドを含む）を使えば
> この問題は起きません。

Turnstile はローカルでは Cloudflare のテスト鍵（常に成功）を使います。
共有ウィジェットのホスト名に `localhost` は入っていません。

```bash
pnpm run lint         # ESLint
pnpm run typecheck    # wrangler types + react-router typegen + tsc
pnpm run check        # lint → typecheck → 単体 → 統合 → build
```

---

## テスト

```bash
pnpm run test              # 単体（DB もネットワークも使わない）
pnpm run test:integration  # 統合（PGlite に本物のマイグレーションを流す）
pnpm run test:e2e          # E2E（本番ビルドに対して Playwright）
```

統合テストは **PGlite（PostgreSQL 17 の WASM ビルド）** をその場で立てます。
Docker も Neon も要りません。実 PostgreSQL に当てたい場合は
`TEST_DATABASE_URL` を設定します。

> **`TEST_DATABASE_URL` に本番と同じデータベースを指定しないでください。**
> 統合テストは全テーブルを TRUNCATE します。Neon は1プロジェクトに複数の
> データベースを作れるため、うっかり同じ URL を指しやすい構造です。

> **⚠ 2026-08-17 まで、統合テストは落ちても終了コードが 0 でした。**
> PGlite の `close()` が WASM ランタイムの終了処理でプロセスの exit code を
> 上書きするため、`test-integration/global-setup.ts` の teardown を通ると
> 失敗が消えていました。**CI の「統合テスト」は落ちるはずの変更でも緑でした。**
> teardown で終了コードを控えて戻すようにしてあります。統合テストを
> 別の仕組みへ移すときは、わざと1件落として `echo $?` が 1 になることを
> 先に確かめてください。

E2E は**本番ビルド**に対して走ります。開発サーバーだと Vite が HMR 用の
インラインスクリプトを差し込み、CSP 違反が必ず出るため、本番の壊れ方と
区別できません。

preview / 本番に当てる場合：

```bash
E2E_BASE_URL=https://nakadachi-preview.rewrite-co.com pnpm run test:e2e
```

---

## デプロイ

詳細は [DEPLOYMENT.md](DEPLOYMENT.md)。

```bash
pnpm run deploy:preview      # preview 環境
pnpm run deploy:production   # 本番
```

`CLOUDFLARE_ENV` はビルド時に効きます。ビルドとデプロイをまたいで
環境を取り違えないよう、上のスクリプトはビルドから通しで行います。

---

## 人間が用意するもの

**私（実装側）が代行しない・できないもの**です。

| # | 項目 | 理由 |
|---|---|---|
| 1 | Neon プロジェクトとデータベース3つ | 課金アカウントの操作 |
| 2 | アプリ用 DB ロール（DDL 権限なし） | 権限設計は運用判断 |
| 3 | R2 バケット3つ | 課金対象リソースの作成 |
| 4 | Cloudflare Workers プロジェクトとカスタムドメイン | 同上 |
| 5 | **このサービス専用の Stripe アカウント** | 事業者としての契約 |
| 6 | Resend の送信ドメイン認証（DNS 変更） | ゾーンの変更 |
| 7 | Secret 10項目の投入 | 値を渡さないため |
| 8 | 初期管理者の作成 | 手順は上記 |
| 9 | GitHub の Secret Scanning / Push Protection | リポジトリ設定 |
| 10 | `rewrite-uptime/src/targets.js` への監視対象追加 | 別リポジトリ |
| 11 | `rewrite-co.com` トップページへのカード追加 | 別リポジトリ |
| 12 | 規約文面の法務確認 | **2026-08-14 完了** |
| 13 | OGP 画像の差し替え | `scripts/make-og-image.mjs` が作るのは単色の仮画像 |

### 規約について

`/legal/terms`・`/legal/privacy`・`/legal/tokushoho`・`/legal/prohibited` は
**2026-08-14 に運営者が法務確認を済ませています。**

> ★文面を大きく書き換えたときは、確認を受け直してください。★
> `app/components/legal-page.tsx` の `showTemplateNotice` を `true` に
> 戻すと、画面に「ひな型です」の但し書きが出ます。確認を受けていない文面を、
> 受けたものと同じ見た目で出さないための仕組みです。
>
> **プライバシーポリシーは 2026-08-14 に発信者情報（IPの6か月保存）を
> 追記しています。** ここは特に変更幅が大きい箇所です。

なお、**運営者情報（氏名・住所・連絡先）はこのリポジトリに書いていません。**
正本は `https://rewrite-co.com/legal/#operator` にあり、絶対URLで参照しています。
複数のサービスに複製すると、住所を変えたときにどれかが必ず古くなるためです。

---

## 本番公開前チェックリスト

- [ ] `pnpm run check` がすべて成功する
- [ ] `pnpm run test:e2e` が成功する
- [x] 規約4ページの法務確認が済んでいる（2026-08-14）
- [ ] Stripe が**テストモードでないこと**を確認した（本番申請が通っている）
- [ ] Stripe の Webhook が本番のドメインを向いている
- [ ] 8種類のイベントをすべて購読している
- [ ] テストモードで110円の決済を1回通し、**Webhook 経由で公開されること**を確認した
- [ ] 返金を1回行い、**投稿が非公開になること**を確認した
- [ ] `/api/config` の `secretsConfigured` がすべて true
- [ ] `/api/health` が**10回連続で** 200 を返す
      （5回では、同じ isolate に当たらず接続の使い回しの不具合を見逃す）
- [ ] 実際のブラウザでログイン → 投稿 → 決済 → 公開まで通した
- [ ] 管理画面に3層すべてを通って入れた（**curl ではなくブラウザで**）
- [ ] Turnstile が効いている（ダミートークンで `turnstile_failed` が返る）
- [ ] `robots.txt` と `sitemap.xml` が正しい内容で返る
- [ ] マイページ・管理画面が `noindex` になっている
- [ ] OGP 画像を差し替えた
- [ ] `rewrite-uptime` に監視対象を追加した
- [ ] `rewrite-co.com` のトップにカードを追加した
- [ ] `新サービス構築ルール.md` の §14 に、今回踏んだ罠を書き戻した

---

## 文書一覧

| 文書 | 内容 |
|---|---|
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | 採用技術と理由、DB 設計、フロー、未確定事項 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 構成、層の分け方、検索の限界、性能上の判断 |
| [SECURITY.md](SECURITY.md) | 対策の一覧、秘密情報の扱い、**ローテーション手順** |
| [THREAT_MODEL.md](THREAT_MODEL.md) | 想定する攻撃者、資産、対策、残余リスク |
| [DEPLOYMENT.md](DEPLOYMENT.md) | 環境の分離、デプロイ手順、切り戻し |
| [OPERATIONS.md](OPERATIONS.md) | 定期処理、監視、バックアップ／復旧、よくある障害 |
| [docs/ROUTES.md](docs/ROUTES.md) | ルート一覧と、それぞれの権限・索引の扱い |
| [docs/night-audit-2026-08-17.md](docs/night-audit-2026-08-17.md) | 2026-08-17 夜の総点検の記録。直したもの・Hyperdrive への切り替え・まだ直していないもの |
