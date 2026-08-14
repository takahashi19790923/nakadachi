# デプロイ

---

## 1. 環境

| | preview | production |
|---|---|---|
| Worker 名 | `nakadachi-preview` | `nakadachi` |
| ドメイン | `nakadachi-preview.rewrite-co.com` | `nakadachi.rewrite-co.com` |
| DB | Neon の preview 用データベース | Neon の本番用データベース |
| R2 | `nakadachi-media-preview` | `nakadachi-media` |
| Stripe | テストモード | 本番モード |

**すべて別系統にしてください。** preview と production で同じ DB や
同じ Stripe アカウントを使うと、テストの決済が本番の記録に混ざります。

---

## 2. 初回だけ必要なこと

### Workers プロジェクトの作成とドメイン

Workers（Pages ではない）は、`wrangler.jsonc` に `custom_domain` を書いて
デプロイすると **DNS レコードまで Cloudflare が作ります**。
Pages のように「API でドメインを足して、DNS は手で追加」という2手順は不要です。

```jsonc
"routes": [{ "pattern": "nakadachi.rewrite-co.com", "custom_domain": true }]
```

副作用として `workers.dev` のルートが自動で無効になります。
同じ内容が2つのホストで見える状態が自動的に無くなるので、
Pages のように転送を自前で書く必要はありません。

> **カスタムドメイン登録の直後は 522（オリジン未接続）が返ります。**
> DNS だけ先に引ける状態になるためです。**`/api/health` が10回連続で 200 を
> 返すまでは「開通した」と言わないでください。**

### Secret の投入

```bash
pnpm run secrets:put -- --env preview
pnpm run secrets:put -- --env production
```

**Secret は「次のデプロイから」しか反映されません。** 投入したら必ず
デプロイし直してください。

---

## 3. 毎回の手順

```bash
# 1. 手元で全部通す
pnpm run check

# 2. preview へ出す
pnpm run deploy:preview

# 3. preview で確かめる（下記のチェック）

# 4. 本番へ出す
pnpm run deploy:production
```

### `CLOUDFLARE_ENV` はビルド時に効く

`@cloudflare/vite-plugin` は、ビルドの時点で `wrangler.jsonc` の環境を
1つに畳んだ設定ファイルを出力します。**デプロイ時に環境を指定しても
効きません。**

`deploy:preview` / `deploy:production` はビルドから通しで行うので、
この取り違えは起きません。**個別に `wrangler deploy` を叩かないでください。**

### デプロイ後の確認

```bash
# ★10回叩く。5回では足りない。★
# 接続の使い回しの不具合は、同じ isolate に当たったリクエストだけが落ちる。
for i in $(seq 1 10); do curl.exe -s -o /dev/null -w "%{http_code} " https://<ホスト>/api/health; done; echo

# 設定が反映されているか（「直したがデプロイし忘れた」をここで捕まえる）
curl.exe -s https://<ホスト>/api/config
```

`/api/config` で確認すること：

- `turnstileSiteKey` が空でないこと（空ならボット対策は効いていない）
- `secretsConfigured` がすべて `true`
- `appOrigin` が正しいこと

> **PowerShell では `curl` と書かないでください。**
> `curl` は `Invoke-WebRequest` の別名で、`-d` を2つ書くと落ちます。
> 本物を使うなら `curl.exe` です。

### ★ブラウザで確かめること★

curl が通ることは「人が使える」ことの証明になりません。

- [ ] トップページで投稿が並ぶ
- [ ] リンクを踏んで画面が切り替わる（ハイドレーションが起きている）
- [ ] ログインフォームを実際に送信できる（Turnstile が効いている）
- [ ] 管理画面に3層すべてを通って入れる

---

## 4. マイグレーション

```bash
# .env の DATABASE_URL を対象環境の「所有者ロール」にしてから
pnpm run db:migrate
pnpm run db:seed
```

**アプリより先に流してください。** 新しい列を使うコードを先に出すと、
その間のリクエストが落ちます。

**後方互換のない変更（列の削除・型の変更）は2段階に分けてください。**

1. 新しい形を足す → デプロイ → 移行 → 古い形を使わなくする
2. しばらく動かす
3. 古い形を消す

---

## 5. 切り戻し

### アプリ

```bash
pnpm exec wrangler deployments list --name nakadachi
pnpm exec wrangler rollback --name nakadachi
```

**Secret は切り戻りません。** 値を変えた直後に切り戻す場合は、
古いコードが新しい Secret で動くことを確認してください。

### DB

マイグレーションの自動的な切り戻しはありません。
[OPERATIONS.md](OPERATIONS.md) の「バックアップと復旧」を参照してください。

**Neon のブランチ機能を使うと、マイグレーション前の状態をそのまま
残しておけます。** 大きな変更の前には作ってください。

---

## 6. 自動デプロイ（Cloudflare Workers Builds）

GitHub Actions には**本番の Secret を持たせていません**。
デプロイは Cloudflare 側と GitHub の連携で行います。

1. Cloudflare のダッシュボード → Workers → 該当プロジェクト → Settings → Builds
2. GitHub リポジトリを接続する
3. ビルドコマンド: `pnpm run build:production`
4. デプロイコマンド: `pnpm exec wrangler deploy`
5. ブランチ: `main`

この構成なら、Cloudflare の API トークンを GitHub に置く必要がありません。

GitHub Actions からデプロイする必要が生じた場合のみ：

- 権限を絞った Cloudflare API トークンを作る
  （Workers Scripts:Edit と、対象アカウントのみ）
- GitHub の **Environment Secrets**（リポジトリ Secrets ではない）に置く
- `production` environment に**承認ルール**を設定する
- **`pull_request_target` を使わない**（フォーク由来のコードに Secret が渡る）

---

## 7. ドメインやプロジェクト名を変えるとき

1. `app/config/site.ts` の `id` と `canonicalOrigin`
2. `wrangler.jsonc` の `name`、各環境の `name` / `APP_ORIGIN` /
   `TURNSTILE_EXPECTED_HOSTS` / `routes`
3. R2 バケット名（作り直しと中身の移行が要る）
4. Stripe の Webhook エンドポイント URL
5. Resend の送信ドメイン（変える場合）
6. `rewrite-uptime/src/targets.js`
7. `rewrite-co.com` トップページのカード

> **`TURNSTILE_EXPECTED_HOSTS` を直し忘れると、ボット検査が全滅します。**
> 共有ウィジェットのため、hostname 照合だけがサービスを分けています。

---

## 8. よくある失敗

| 症状 | 原因 | 対処 |
|---|---|---|
| デプロイは成功するのに設定が古いまま | `CLOUDFLARE_ENV` がビルド時に効いていない | `deploy:preview` / `deploy:production` を使う |
| Secret を入れたのに反映されない | Secret は次のデプロイから | デプロイし直す |
| 10回中2回だけ 500 | DB クライアントのリクエスト跨ぎ | ローカルでは再現しない。`createRequestDb` を経由しているか確認 |
| 開通直後に 522 | Pages 側がまだ初期化中 | 数分待って測り直す |
| 認証が全部 503 | `TURNSTILE_SECRET_KEY` の投入漏れ | `/api/config` の `secretsConfigured.turnstile` を見る |
| 画面は出るがボタンが反応しない | CSP の nonce が届いていない | `e2e/hydration.spec.ts` を流す。curl では絶対に分からない |
| デプロイ直後の確認が通らない | エッジで新旧が混ざる数十秒 | 1回落ちたら間を置いて再確認する |
