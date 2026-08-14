# セキュリティ

このサービスで実際に効かせている対策と、秘密情報の扱いをまとめています。
攻撃者像と残余リスクは [THREAT_MODEL.md](THREAT_MODEL.md) を参照してください。

---

## 1. 対策の一覧

| 分類 | 対策 | 実装 |
|---|---|---|
| 入力検証 | すべてサーバー側で Zod。カテゴリごとに判別可能な合併にして、想定外の項目を落とす | `app/domain/validation/` |
| SQL インジェクション | Drizzle のプレースホルダ。生 SQL も `sql` テンプレートでパラメータ化。LIKE のメタ文字をエスケープ | `app/server/repositories/` |
| XSS | React の既定エスケープ。`dangerouslySetInnerHTML` は構造化データ（JSON-LD）のみで、`<` をエスケープ済み。メッセージは常にプレーンテキスト | `app/routes/listing-detail.tsx` |
| CSRF | Origin/Referer の**完全一致**照合 ＋ 署名付き二重送信トークン。**両方必須** | `app/server/csrf.server.ts` |
| IDOR | ULID ＋ 全 API での所有者確認。他人のものは **404**（403 だと存在が分かる） | `app/server/guards.server.ts` |
| SSRF | 外部への `fetch` 先は Stripe / Resend / Turnstile の定数 URL のみ。利用者入力から URL を組み立てない | — |
| オープンリダイレクト | 戻り先はパスのみ受理。`//` とバックスラッシュも拒否 | `safeRedirectPath` |
| セッション固定 | ログインのたびに新しいセッション行とトークンを作る | `app/server/session.server.ts` |
| ログインコードの保存 | **6桁は鍵無しハッシュにしない。** `HMAC-SHA256(SESSION_SECRET, "otp:{トークンID}:{コード}")`。素の sha256 だと100万通りの表で DB から全件復元できる。トークンIDを混ぜるのは、同時に発行された他のコードへ波及させないため | `crypto.server.ts` の `otpHash` |
| クリックジャッキング | `X-Frame-Options: DENY` ＋ CSP `frame-ancestors 'none'` | `security-headers.server.ts` |
| CSP | nonce 方式。**`script-src` に `'unsafe-inline'` を入れない** | 同上 |
| HSTS | `max-age=31536000; includeSubDomains`（`preload` は付けない） | 同上 |
| レート制限 | アプリ側（`rate_limits` 表）。用途ごとに窓と回数を定義 | `rate-limit.server.ts` |
| ボット対策 | Turnstile。**共有ウィジェット ＋ hostname 完全一致照合 ＋ fail-close** | `turnstile.server.ts` |
| 権限 | ローダー・アクションの先頭で必ず guard を通す | `guards.server.ts` |
| 監査 | 管理操作は `admin_actions` と `audit_logs` に記録。理由の入力を必須にしている | `audit.server.ts` |
| ログ | 構造化 ＋ 鍵名によるマスキング。メールアドレスは `maskEmail` を通す | `logger.server.ts` |
| エラー | 利用者向け文言と内部詳細を分離。本番でスタックトレースを出さない | `errors.ts` |

### 個人情報の持ち方

- **メールアドレスは平文で保存しません。** AES-GCM の暗号文と、別鍵の HMAC の2本立て。
  検索と一意制約は HMAC 側で行います。
- **IP アドレスは、用途で扱いを分けています。**
  - セッション・確認トークン・監査ログは**鍵付きハッシュだけ**。元に戻せません
    （IPv4 は43億通りしかなく、鍵なしのハッシュは総当たりで戻せるため）。
  - **`access_records` だけは AES-GCM の暗号文**で、復号できます。
    会員登録・ログイン・掲載の申し込み・メッセージ送信・通報の5つが対象です。
    **鍵（`ACCESS_LOG_KEY`）はセッション・メールとは別**にしています。
  - **6か月で自動削除**します（`pnpm run cron purge-access`）。
    プライバシーポリシーの記載と一致させること。

  > 詐欺の被害者からの発信者情報開示請求（情報流通プラットフォーム対処法）や
  > 捜査関係事項照会で求められるのは**IPそのもの**です。ハッシュしか持たないと
  > 「ポリシーには開示すると書いてあるのに出せるものが無い」になります。
- **`audit_logs` は `users` への外部キーを張っていません。** 張ると退会時に
  「消したという記録」まで消えます。
- **退会削除は `user_id` と `email_hmac` の両方で辿ります。** 片方だけだと
  メール配信ログと確認トークンが残り、「30日後に削除」が嘘になります。

### CSP について

nonce 方式が成立するのは、**全ページをリクエストごとに描いているから**です
（`react-router.config.ts` の `ssr: true`、プリレンダリング無し）。

ビルド時に HTML を焼くページを足すと、そのページだけ nonce が一致せず、
**見た目は正常なのにボタンだけ反応しない**状態になります。curl では 200 が
返り、文言もマークアップも正しく見えるため、目視では絶対に気づけません。

`e2e/hydration.spec.ts` が実ブラウザでこれを見張っています。
**このテストを消さないでください。**

nonce は React コンテキスト（`app/nonce.ts`）で運んでいます。
ローダーのデータ経由にすると、`Layout` が `loaderData` を受け取れない場面で
空になります。`<Scripts>` だけでなく **`<ServerRouter>` にも渡す**必要があります
（ストリーミング中のインライン script は別経路で出るため）。

---

## 2. DB ロールの分離

| ロール | 権限 | 用途 |
|---|---|---|
| 所有者ロール | DDL 可 | マイグレーション（`pnpm run db:migrate`）だけに使う |
| アプリ用ロール | `SELECT` / `INSERT` / `UPDATE` / `DELETE` のみ | Workers が実行時に使う |

Neon での作り方：

> **★Neon のロールはプロジェクト全体で共有されます。★ データベース単位ではありません。**
> 1つの `nakadachi_app` を preview と本番の両方で使うと、preview 側の資格情報が
> 漏れたときに本番のデータベースへそのまま繋がります。**環境ごとに別のロール**
> （`nakadachi_app_preview` / `nakadachi_app_production`）にしてください。
>
> さらに **PUBLIC から `CONNECT` を剥がす**必要があります。PostgreSQL は既定で
> PUBLIC に CONNECT を与えるので、ロールを分けただけでは越境できます。

> **実測（2026-08-14）── pooled 経由ではデータベース単位の権限が効きません。**
>
> | 経路 | 越境しようとした結果 |
> |---|---|
> | 直接接続（`-pooler` なし） | `permission denied for database "nakadachi"` |
> | **pooled（`-pooler` あり）** | **接続は通る。** ただし `permission denied for table locations` |
>
> つまり **データは読めませんが、接続そのものは張れます**（システムカタログ
> 経由で表名などは見えます）。アプリは pooled を使うので、この状態が既定です。
>
> **★2026-08-14、本番を専用の Neon プロジェクトへ分離しました。★**
> Neon のロールはプロジェクト単位なので、preview の資格情報では本番
> プロジェクトのホストに対して**認証そのものが通りません**（実測済み）。
> これで pooled の穴も塞がっています。
>
> | | プロジェクト | データベース |
> |---|---|---|
> | dev / preview | `nakadachi`（gentle-wildflower） | `nakadachi_dev` / `nakadachi_preview` |
> | **本番** | **`nakadachi-production`（lucky-pine）** | `nakadachi` |
>
> ⚠️ **移行元にも同名の `nakadachi` が残っています。** データベース名だけを
> 見る検査では区別できないので、`scripts/db.ts` はエンドポイント名も見ます。

```sql
-- アプリ用ロール（DDL を与えない）。★環境ごとに別の名前にする★
CREATE ROLE nakadachi_app_production WITH LOGIN PASSWORD '<vault で管理>';
-- ★既定で誰でも繋げるのを閉じる★
REVOKE CONNECT ON DATABASE nakadachi FROM PUBLIC;
GRANT CONNECT ON DATABASE nakadachi TO nakadachi_app_production;
GRANT USAGE ON SCHEMA public TO nakadachi_app_production;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nakadachi_app_production;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nakadachi_app_production;

-- 今後作られる表にも同じ権限を既定で付ける
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nakadachi_app_production;
```

**`DATABASE_URL`（Workers の Secret）にはアプリ用ロールを入れます。**
所有者ロールは、マイグレーションを流す人の `.env` にだけ置きます。

---

## 3. 秘密情報の扱い

### コミットしてはいけないもの

`.env` / `.dev.vars` / Neon 接続文字列 / Resend API キー / Stripe のキーと
Webhook シークレット / Cloudflare API トークン / R2 アクセスキー /
セッション署名鍵 / 本番のメールアドレス一覧 / 利用者の個人情報 / DB ダンプ /
本番のログ。

`.gitignore` に列挙してあります。ブロックリストは「除外し忘れ＝即コミット」
なので、**新しい秘密ファイルを作るときは、まず `.gitignore` に足してから
中身を書いてください。**

### 三重の防御

1. **GitHub Push Protection** — 秘密情報を含む push 自体が止まる（第一防御）
2. **GitHub Secret Scanning** — 履歴を継続的に走査する
3. **`scripts/check-secrets.mjs`** — 手元の pre-commit フック。独自形式も見る

```bash
node scripts/check-secrets.mjs --install
```

CI では `.github/workflows/secret-scan.yml` が同じ検査を行います。

---

## 4. 秘密情報のローテーション手順

> **一度でも push した値は、消しても漏れたものとして扱ってください。**
> Git の履歴は書き換えられますが、fork・キャッシュ・CI のログには残ります。

### 共通の流れ

1. **止める**（古い値を無効化する）
2. **入れ替える**（新しい値を発行して投入する）
3. **確かめる**（実物で疎通を確認する）
4. **記録する**（いつ・何を・なぜ替えたかを残す。値は書かない）

### 値ごとの手順

#### `DATABASE_URL`（Neon）

1. Neon のコンソールで、該当ロールのパスワードをリセットする
2. **古いパスワードは即座に無効になる**（アプリは一時的に落ちる）
3. 新しい pooled 接続文字列を `pnpm run secrets:put -- --env production` で投入
4. **デプロイし直す**（Secret は次のデプロイから効く）
5. `/api/health` が10回連続で 200 になることを確認

#### `SESSION_SECRET`

1. 新しい値を投入してデプロイする
2. **全利用者のセッションと CSRF トークンが無効になる**（全員ログアウト）
3. 影響が大きいので、漏えい時以外は行わない

#### `EMAIL_ENCRYPTION_KEY` / `EMAIL_INDEX_KEY`

> **★この2つは単純に差し替えられません。★**
> 暗号化鍵を替えると既存の暗号文が復号できず、索引鍵を替えると
> 既存の利用者が誰も引けなくなります（＝全員ログイン不能）。

漏えいした場合の手順：

1. 新旧2つの鍵を同時に使える状態にする（コードの変更が要る）
2. 全行を新しい鍵で入れ直す移行スクリプトを流す
3. 完了を確認してから、古い鍵を外す

**この作業には移行用のコードが必要です。** 発生時に慌てて手作業で
やらないでください。

#### `RESEND_API_KEY`

1. Resend で新しいキーを発行する
2. 投入してデプロイする
3. 古いキーを **Resend 側で失効させる**
4. 実際にログインメールを1通送って届くことを確認

#### `STRIPE_SECRET_KEY`

1. Stripe のダッシュボードでキーをローテートする
2. 「古いキーを何時間で失効させるか」を選ぶ（即時ではなく猶予を置ける）
3. 投入してデプロイする
4. **テストモードで110円の決済を1回通して確認**
5. 猶予が切れる前に完了させる

#### `STRIPE_WEBHOOK_SECRET`

1. Stripe で Webhook エンドポイントの署名シークレットをロールする
2. 投入してデプロイする
3. Stripe のダッシュボードからテストイベントを送り、
   `payment_webhook_events` に `processed` で入ることを確認
4. **確認できるまで古い値も有効にしておく**（Stripe は猶予期間を設けられる）

#### `TURNSTILE_SECRET_KEY`

> **サイトキーとシークレットは対です。** 片方だけ替えた瞬間から、
> もう片方を替えるまで**新規登録・ログインが全部止まります**。

1. `wrangler.jsonc` のサイトキーを書き換える（ローカルなので本番に影響しない）
2. **配る前にシークレットを単体で検証する**（間違った鍵で全認証を止めない）
3. `pnpm run secrets:put` → **間を空けずにデプロイ**
4. `/api/config` で配られているサイトキーを確認（伝播に数分かかる）
5. 実際にログインを1回通す

移行前のサイトキーを控え、1コマンドで戻せる状態にしておいてください。

> このアカウントでは **Turnstile は共有ウィジェット1つ**を全サービスで
> 使っています。替えると**全サービスに影響します**。単独で判断しないでください。

#### `ADMIN_BASIC_AUTH_USER` / `PASS`

> **全プロジェクト共通の値です。** 替えたら**全プロジェクトの再デプロイが必須**
> です（Secret は次のデプロイからしか反映されません）。

1. 新しい値を決める
2. すべてのプロジェクトへ投入する
3. すべてのプロジェクトを再デプロイする
4. **ブラウザで**管理画面に入れることを確認する（curl では確認にならない）

なお、管理画面の通過証（Cookie）の署名鍵は**この値そのものから作っています**。
値を替えれば、発行済みの通過証はその場で全部無効になります。

---

## 5. 誤ってコミットしてしまったら

1. **まず値を無効化する**（上のローテーション手順）。履歴の書き換えより先
2. リポジトリが公開なら、**その値は漏れたものとして扱う**
3. Git 履歴から消す（`git filter-repo` など）。ただし完全ではない
4. GitHub のサポートへキャッシュの削除を依頼する
5. いつ・何が・どこへ出たかを記録する（値そのものは書かない）
6. 影響範囲を確認する（Stripe の決済履歴、Neon の接続ログ、Resend の送信履歴）

---

## 6. 報告先

脆弱性を見つけた場合は `support@rewrite-co.com` までご連絡ください。
公開の issue には書かないでください。
