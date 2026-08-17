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

### DB は Supabase（東京）＋ Hyperdrive

| 環境 | DB | 経路 |
|---|---|---|
| **本番** | **Supabase PostgreSQL（ap-northeast-1・東京）** プロジェクト `nakadachi`（ref `eejuzgepfjkfscutstdm`）、データベース `postgres` | Cloudflare Hyperdrive `nakadachi-production-tokyo`（キャッシュ無効） |
| preview | Neon（ap-southeast-1）`nakadachi_preview` | Hyperdrive `nakadachi-preview` |
| dev / テスト | Neon `nakadachi_dev` / PGlite | 直接（Neon serverless ドライバ） |

**2026-08-18、本番を Neon（シンガポール）から Supabase（東京）へ移しました。**
きっかけは前夜の経路障害（Cloudflare → Neon シンガポールが 2〜40秒に詰まる、下記）と、
Neon Free の CU 時間の上限（1日 13時間まで）。移行後の実測: `/api/health` の DB 往復
**7〜60ms**（Neon 経由は 73〜75ms）、トップ 0.07〜0.13秒（0.21〜0.44秒）、
カテゴリ一覧 0.08〜0.17秒（0.22〜0.39秒）。

Hyperdrive は DB の近くの Cloudflare 拠点で接続を張りっぱなしにして使い回すので、
リクエストごとに TCP/TLS を張り直しません。

#### 作り方（本番）

```bash
# 1. Supabase のダッシュボードでプロジェクトを作る（東京・Data API オフ・自動 RLS オフ）
#    Settings → Database → Reset database password で作ったパスワードを .env の
#    DATABASE_URL_PRODUCTION に入れる（所有者 postgres。Direct connection 5432）
pnpm run db:check production
pnpm run db:migrate production --yes      # スキーマ（0000 の pg_trgm を含む）
pnpm run db:create-app-role               # DDL 無しのアプリロールを作り .env に書く（表示しない）
pnpm run db:migrate-to-supabase           # 件数の下見
pnpm run db:migrate-to-supabase -- --apply  # 行を移して件数を照合（移行元には書かない）
# 2. Hyperdrive。接続文字列は .env の DATABASE_URL_APP_PRODUCTION（引数に貼らずスクリプトで読む）
pnpm exec wrangler hyperdrive create nakadachi-production-tokyo --connection-string="postgresql://…" --caching-disabled=true
# 3. wrangler.jsonc の env.production.hyperdrive[].id を書き換えてデプロイ
```

- ★**Direct connection（`db.<ref>.supabase.co:5432`）を使う。★ プーラー（6543 / pooler.supabase.com）は
  使わない。Hyperdrive が自前でプールするので、二重にプールしない（Cloudflare 公式の指示）。
  Direct connection は IPv6 だけ。手元の PC は IPv6 で繋げた
- ★キャッシュは切る（`--caching-disabled=true`）。★ 切らないと投稿直後の一覧に最大60秒古い結果が出る
- ★Supabase の証明書は素の `pg` では検証できない。★ 手元のスクリプトは `sslmode=no-verify`
  （暗号化のみ）。`sslmode=require` を付けると pg は verify-full 扱いにして
  `SELF_SIGNED_CERT_IN_CHAIN` で落ちる。Hyperdrive 側は既定（require）
- ★Supabase Free には DB 側のバックアップも PITR も無い。★ 自前の R2 への書き出しを
  **毎日・14世代**にしてある（OPERATIONS.md）。Free の上限は DB 500MB・転送 5GB/月。
  7日間まったく使われないと停止するが、死活監視が15分ごとに叩くので当たらない
- `.env` の名前: `DATABASE_URL_PRODUCTION`（Supabase・所有者）、`DATABASE_URL_APP_PRODUCTION`
  （Supabase・アプリロール）、`DATABASE_URL_PRODUCTION_NEON` / `DATABASE_URL_APP_PRODUCTION_NEON`
  （移行元。退避路として当面残す）

#### 切り戻し・後片づけ

- **Neon へ戻す**: `wrangler.jsonc` の `env.production.hyperdrive[].id` を
  `bc7ebd4ecfdc4b70a4860fb2338418e2`（Neon 向け）に戻してデプロイ。★移行後の書き込みは戻らない★
- **Hyperdrive を外す**: `hyperdrive` の項目を消すと `DATABASE_URL`（Workers の Secret ＝ Neon の
  アプリロール）へ Neon serverless ドライバで直接繋ぐ。これも Neon の古いデータ
- ★Neon を消すとき★（数日様子を見てから）: Neon プロジェクト `nakadachi-production` と Hyperdrive
  `bc7ebd4ec…` を消し、`app/server/db.server.ts` の「binding が無ければ Neon」の分岐を
  **本番では HYPERDRIVE 必須**に変える（Neon のドライバは Supabase とは話せないので、
  退避路は Neon が消えた瞬間に死ぬ）。`.env` の `*_NEON` も消す

#### 経緯（2026-08-17 夜の経路障害）

22:50 JST 頃から、Cloudflare（NRT）→ Neon（ap-southeast-1）への直接接続が 2〜40秒に
振れる時間帯が2時間以上続き、`/api/health` が 100% タイムアウトするところまで悪化した。
手元の PC や Vercel からは 70〜250ms で返り、HTTP でも WebSocket でも同じだったので、
Neon 本体ではなく経路の問題。まず Hyperdrive（Neon のまま）に切り替えて収まり
（一覧 0.22〜0.70秒）、翌朝 Supabase 東京へ移した。

**ローカルとテストには binding が無い**ので、従来どおり直接繋ぎます。

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
# .env に DATABASE_URL_DEV / _PREVIEW / _PRODUCTION（所有者ロール）を置いた上で
pnpm run db:migrate                     # dev
pnpm run db:migrate preview
pnpm run db:migrate production          # "production" と打つ確認あり
pnpm run db:migrate production --yes    # 確認を飛ばす（自動化・無人のとき）
```

**アプリより先に流してください。** 新しい列を使うコードを先に出すと、
その間のリクエストが落ちます。実際に踏んだ形: `0003` で `listings.duration_days`
を足したあと、dev DB に流す前に E2E を回して `column listings.duration_days
does not exist` で 500（2026-08-17）。**順番は「3環境のマイグレーション →
preview デプロイ → 本番デプロイ」。**

適用済みの版は `drizzle.__drizzle_migrations` 表で確認できます。

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
