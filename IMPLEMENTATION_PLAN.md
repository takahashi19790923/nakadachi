# NAKADACHI（なかだち）実装計画

地域密着型クラシファイド／マーケットプレイス。日本国内向け、日本語のみ。

> **仮称です。** ブランド名は `app/config/site.ts` の1か所に集約してあります。
> 変えるときはそこだけを直せば、画面・メール・OGP・構造化データすべてに反映されます。
> Cloudflare のプロジェクト名とサブドメイン（`nakadachi`）だけは、変更時に
> 手作業の付け替えが要ります（DEPLOYMENT.md 参照）。

---

## 0. この計画で守ること

| 決めごと | 根拠 |
|---|---|
| 掲載料は 1件 110円（税込）。閲覧と会員登録は無料 | 依頼のビジネスルール |
| 金額はサーバー側の定数が唯一の正。クライアントから来た金額は一切使わない | 同上 |
| 公開は **署名検証済み Webhook を受けてから**。success URL を踏んだだけでは公開しない | 同上 |
| 広告枠を作らない | 同上 |
| ジモティ等の名称・文章・画像・配色・画面構成を参照しない。スクレイピングもしない | 同上 |
| 運営者情報（氏名・住所・連絡先）はこのリポジトリに書かない | `新サービス構築ルール.md` §3 |
| Turnstile は共有ウィジェットを流用し、新規作成しない | 同 §3.5 |
| 管理画面の第3層はブラウザの Basic 認証ダイアログにしない | 同 §4 と過去の失敗 |

---

## 1. 採用技術と、その理由

### 1.1 依頼どおり採用したもの

| 用途 | 採用 | 版 | 確認したこと |
|---|---|---|---|
| ホスティング／実行環境 | Cloudflare Workers | compat 2026-08-13 / `nodejs_compat` | — |
| フレームワーク | React Router | **8.3.0** | Cloudflare 公式ガイドが v8 を案内していることを実測確認 |
| ビルド | Vite | 8.2.1 | `@cloudflare/vite-plugin` 1.52.0 の peer に合致 |
| DB | Neon PostgreSQL | — | — |
| DB アクセス | `@neondatabase/serverless` | 1.1.0 | Workers の WebSocket / fetch を使用。Node 専用 API に依存しない |
| ORM / マイグレーション | Drizzle ORM / drizzle-kit | 0.45.2 / 0.31.10 | 生成した SQL を目視確認済み |
| 写真 | Cloudflare R2（binding 経由） | — | アカウントで R2 有効化済みを確認（`wrangler r2 bucket list` が応答） |
| メール | Resend | HTTP API | — |
| 決済 | Stripe Checkout | HTTP API | — |
| スタイル | Tailwind CSS | 4.3.3 | — |
| 検証 | Zod | 4.4.3 | — |
| テスト | Vitest / Playwright | 4.1.10 / 1.62.1 | — |
| パッケージ管理 | pnpm | 11.21.0 | — |

### 1.2 依頼から外した判断と、その理由

**TypeScript は 7.0.2 ではなく 5.9.3。**
最新は 7.0.2 ですが、`typescript-eslint` の peer が `>=4.8.4 <6.1.0` で、TS 7 では
lint が動きません。React Router 公式テンプレートも 5.9.3 を指定しています。
「lint・typecheck・test・build がすべて成功する」を完了条件にしている以上、
検査が動かない組み合わせは選べません。typescript-eslint が対応したら上げます。

**Stripe / Resend の公式 SDK を使わず、`fetch` の薄いクライアントを自作。**
理由は3つ。
1. Webhook の署名検証を **ネットワーク無しで単体テストできる**。SDK の
   `constructEventAsync` に委ねると、「不正な署名を拒否する」テストが書きにくい。
2. Workers のバンドル上限（gzip 3MB）に対して、SDK は使う機能に比して大きい。
3. 使うのは Checkout Session 作成・Refund 作成・PaymentIntent 取得の3つだけで、
   いずれも form-encoded な単純な POST。抽象化の利得より、依存の重さが勝る。
決済処理は `app/server/services/payment/` にサービス層として閉じてあるので、
将来 SDK へ戻すことも、決済事業者を替えることもできます。

**Node は 24.19.0（LTS）へ更新しました。**
React Router 8 のビルドが Node ≥ 22.22.0 を要求し、この PC は 22.16.0 でした。
`winget install OpenJS.NodeJS.LTS` の解決先が **24.19.0** だったため、
22 系のパッチ更新ではなくメジャー更新になっています。実行環境（workerd）には
無関係で、影響はローカルのビルドと CI だけです。

### 1.3 構築ルール（`新サービス構築ルール.md`）から外れる点

| 外れる点 | 理由 | 代替 |
|---|---|---|
| DB が D1 ではなく Neon PostgreSQL | 依頼で明示指定。加えて、決済確定と公開を1トランザクションで行う必要があり、D1 のアダプタはインタラクティブなトランザクションに対応しない | ルール §1 の但し書き（vtuber-sns / trackflow-jp と同じ例外）に沿う |
| Pages ではなく Workers | React Router を SSR で動かすため | ルール §2 の「Workers なら DNS も自動」経路を使う。`routes` に `custom_domain` を書く |
| 法定文書の本文をアプリ内に持つ | C2C マーケットは既存ツール群と規約の性質が根本的に違う（当事者間取引の免責・禁止出品物・掲載料の返金条件）。利用者の合意対象なので、サービスと同じ場所に置く | **運営者情報・Cookie ポリシーは持たず** `rewrite-co.com/legal/` へ絶対URLで参照。重複させない |

---

## 2. ディレクトリ構成

```
nakadachi/
  app/
    config/site.ts              ブランド名・URL・連絡先の唯一の置き場所
    domain/                     純粋なロジック（I/O 無し。クライアントからも import 可）
      categories.ts             5カテゴリと選択肢の定義
      listing-status.ts         ステータスと許可された遷移
      listing-types.ts          画面とサーバーが共有する型
      listing-view.ts           金額・日付の表示整形
      pricing.ts                110円。金額検証
      seo.ts                    meta / OGP / canonical
      ulid.ts                   ID 生成と検証
      validation/               Zod スキーマ
    server/                     サーバー専用（*.server.ts。クライアントから import 不可）
      env.server.ts             環境変数の入口。fail-close
      db.server.ts              リクエストごとの DB クライアント
      crypto.server.ts          ハッシュ・HMAC・AES-GCM・定数時間比較
      session.server.ts         セッション
      csrf.server.ts            Origin 照合 + 署名付きトークン
      turnstile.server.ts       hostname 完全一致照合
      rate-limit.server.ts      アプリ側レート制限
      admin-gate.server.ts      管理画面の第3層
      guards.server.ts          権限判定
      security-headers.server.ts  CSP（nonce）ほか
      repositories/             データアクセス層
      services/                 決済・メール・画像・投稿・メッセージ
    components/                 画面部品
    routes/                     ルートモジュール
    db/
      schema/                   Drizzle スキーマ
      migrations/               生成された SQL
  workers/app.ts                Workers の入口。ヘッダ・nonce・正規ホスト
  scripts/                      マイグレーション・seed・秘密情報投入・定期処理
  test/                         単体テスト
  test-integration/             統合テスト（PGlite に本物のマイグレーションを流す）
  e2e/                          Playwright
  docs/                         ルート仕様ほか
```

**クライアントとサーバーの分離**は `*.server.ts` の命名で機械的に保証します。
React Router は `loader` / `action` / `middleware` / `headers` からしかサーバー
コードを取り除かないので、`meta` や部品がサーバーモジュールを辿るとビルドが
落ちます。**この「落ちる」が防御**なので、回避せず型と定数を `domain/` へ出します。

---

## 3. DB 設計

23テーブル。すべて ULID（26文字）を主キーに持ちます。

### 3.1 一覧

| 群 | テーブル |
|---|---|
| 利用者 | `users` `user_profiles` `sessions` `email_verification_tokens` `account_deletion_requests` |
| マスタ | `categories` `locations` |
| 投稿 | `listings` `listing_category_details` `listing_images` `favorites` |
| 決済 | `payments` `payment_webhook_events` |
| メッセージ | `conversation_threads` `conversation_participants` `messages` `blocks` |
| 通報・管理 | `reports` `banned_words` `admin_actions` |
| 運用 | `audit_logs` `email_delivery_logs` `rate_limits` |

### 3.2 効かせている制約

| 制約 | 何を防ぐか |
|---|---|
| `payments.checkout_session_id` に一意 | 同じ投稿への二重課金。アプリ側の重複チェックが競合で抜けてもここで落ちる |
| `payment_webhook_events (provider, event_id)` に一意 | Webhook の二重処理。INSERT が落ちることを「処理済み」の判定に使う |
| `users.email_hmac` に一意 | 同一アドレスの二重登録 |
| `reports` の CHECK（対象がちょうど1つ） | 対象不明の通報行 |
| `conversation_threads (listing_id, initiator_id)` に一意 | 同じ相手との会話が複数本に割れる |
| `account_deletion_requests` の部分一意（pending のみ） | 退会依頼の重複 |
| 金額はすべて `integer`（円） | 丸め誤差による表示と請求の食い違い |

### 3.3 個人情報の持ち方

- **メールアドレスは平文で持たない。** AES-GCM の暗号文（`email_encrypted`）と、
  別鍵の HMAC（`email_hmac`）の2本立て。検索・一意制約は HMAC 側で行う。
- **IP は保存しない。** 鍵付きハッシュだけを持つ（IPv4 は総当たりで戻せるため鍵付き）。
- **`audit_logs` は `users` への外部キーを張らない。** 張ると退会時に「消したという
  記録」まで消える。ULID を文字列として持ち、参照整合性より記録の残存を優先する。
- **退会削除は `user_id` と `email_hmac` の両方で辿る。** 片方だけだと
  メール配信ログや確認トークンが残り、「30日後に削除」が嘘になる。

### 3.4 カテゴリ固有項目

検索・並べ替えに使う項目は `listings` と `listing_category_details` の**列**に置き、
表示するだけの補助情報のみ `listing_category_details.extra`（JSONB）に入れます。

`listings.price_jpy` は「その投稿を代表する金額」。売買なら価格、貸出なら料金、
求人なら給与の下限。単位は `price_unit`（一括／時間／日／週／月／年）で表します。
カテゴリごとに列を分けると「価格順に並べる」がカテゴリ分岐で壊れるためです。

### 3.5 検索

日本語は語の区切りが無く、`to_tsvector` の既定辞書では実用になりません。
`search_text`（生成列：タイトル＋本文＋地域メモ）に **pg_trgm の GIN 索引**を張り、
`ILIKE` で引きます。マイグレーション `0000_extensions.sql` が拡張を先に入れます。

**限界を承知の上での MVP の選択です。** 2文字以下の検索語では索引が効きません。
将来は日本語形態素解析（pgroonga / pg_bigm。ただし Neon では未提供）か、
外部の検索サービスへ移す必要があります。ARCHITECTURE.md に記載します。

---

## 4. ルート一覧

詳細は `docs/ROUTES.md`。noindex の扱いをここで一覧します。

| 区分 | パス | 索引 |
|---|---|---|
| 公開 | `/` `/categories` `/c/:slug` `/area/:pref[/:city]` `/search` `/listings/:id` | **索引する**（`/listings/:id` は公開中のみ） |
| 規約 | `/legal/terms` `/legal/privacy` `/legal/tokushoho` `/legal/prohibited` `/guide/safety` `/contact` | 索引する |
| 認証 | `/login` `/login/verify` `/login/link` `/login/error` `/logout` | noindex |
| 利用者 | `/mypage/**` `/listings/new` `/listings/:id/**` | noindex |
| 管理 | `/admin/**` | noindex |
| 機械向け | `/robots.txt` `/sitemap.xml` `/api/health` `/api/config` `/api/stripe/webhook` `/media/:key` | — |

どれにも当たらないパスは `*` ルートが **404** を返します。SPA フォールバックで
全パスに 200 を返す作りにはしません（404 が機能しなくなり、監視も無意味になる）。

---

## 5. 投稿ステータスの遷移

```
draft ──(本人が決済へ)──> payment_pending ──(Webhook: 支払確定)──> published
  ^                            │                                      │
  └──(中止・Session 失効)───────┘                                      │
                               │                                      ├─(本人)─> closed
                    (後払い)   └──> payment_processing ──(確定)────────┤
                                          │                            ├─(期限)─> expired
                                          └──(失敗)──> payment_pending  │
                                                                        ├─(管理者)─> suspended ──(管理者)──> published
                                                                        └─(管理者)─> rejected
```

- **`closed` → `published` は存在しません。** 掲載終了後の再掲載は新しい投稿として
  作り直し、あらためて 110円を課金します。戻せると1回の課金で何度でも掲載できます。
- **公開済み投稿の通常編集では再課金しません。** 状態は `published` のままです。
- **管理者による非公開（`suspended`）で自動返金はしません。** 返金は管理画面から
  明示的に実行します。
- 遷移は `app/domain/listing-status.ts` の `assertTransition` を必ず通します。
  リポジトリ層に status を直接書き換える関数を置きません。

---

## 6. 決済フロー

```
1. 利用者が下書きを保存                      （課金しない）
2. サーバーが投稿内容と所有者を検証
3. サーバーが 110円の Checkout Session を作成  ← 金額はサーバー定数。クライアントの値は使わない
   ・payments へ status='created' で記録（checkout_session_id は一意）
   ・投稿を draft → payment_pending
   ・metadata に listing_id / user_id を載せる
4. Stripe の決済画面へ遷移
5. Webhook を受信 → 署名を検証（WebCrypto の HMAC-SHA256、時刻の許容差 5分）
6. payment_webhook_events へ INSERT（event_id が一意）
   ・一意制約違反 = 既に処理済み → 200 を返して終了
7. 検証：支払額 == 110 / 通貨 == jpy / listing_id と user_id が payments の行と一致
   ・1つでも違えば公開しない。payments に記録を残し、管理者へ通知
8. トランザクション内で payments.status='succeeded' と listings.status='published' を更新
9. published（published_at と expires_at を設定）
10. Resend で掲載完了メール（失敗しても 8・9 をロールバックしない）
```

**`/listings/:id/pending`（決済完了待ち）は success URL からの戻り先ですが、
そこでは状態を変えません。** 数秒おきに状態を問い合わせ、`published` になったら
投稿ページへ進みます。Webhook が来なければ待ち続け、案内を出します。

**返金：** 管理画面から実行。`charge.refunded` / `refund.created` / `refund.updated` /
`charge.dispute.created` を購読し、どれか1つでも届けば `payments` を更新します
（`charge.refunded` が届かない事例が実際にあるため、複数を購読して冗長化）。

---

## 7. 認証フロー（パスワードレス）

```
1. /login でメールアドレス + Turnstile
   ・Turnstile はハンドラのいちばん外側。入力検証より前に置く
   ・レート制限：IP 単位 10回/10分、アドレス単位 5回/10分
2. サーバーが乱数トークン（32B）と6桁 OTP を生成
   ・DB には SHA-256 だけを保存。平文は保存しない
   ・有効期限 15分。attempt_count で総当たりを止める
3. Resend でメール送信（リンクと OTP の両方を載せる）
4. 応答は「登録済みかどうかに関わらず同じ文言」
   ★アドレスが登録済みかを応答から推測できないようにする★
5a. リンクを踏む → /login/link?token=...
5b. OTP を入力 → /login/verify
6. 検証成功 → consumed_at を立てて再利用不可に
7. ユーザーが無ければこの時点で作成（登録＝初回ログイン）
8. ★新しいセッション行とトークンを作る（既存を使い回さない）★ = セッション固定攻撃対策
9. __Host- 接頭辞つき HttpOnly / Secure / SameSite=Lax の Cookie を発行
```

**管理者は3層。**
1. 上記のメールログイン
2. 管理者用の再認証（管理画面に入るとき、あらためて OTP を送る）
3. `/admin/gate` の入力欄（全プロジェクト共通の `ADMIN_BASIC_AUTH_USER` / `PASS`）
   → 通過の証拠は署名付き Cookie（12時間）。署名鍵を資格情報そのものから作るので、
   値を変えれば発行済みの証拠が即座に全部無効になる。

**ブラウザの Basic 認証ダイアログは使いません。** fetch 主体の画面では 401 に対して
資格情報の窓が出ず、正しい値を知っていても入れなくなります。curl では通るので
実装者は「動いた」と誤認します（過去に別サービスで実際に起きています）。

---

## 8. 画像アップロードフロー

**Workers 経由の方式を採ります。** 署名付き直アップロードは検査を挟めず、
「アップロード済みだが検査に落ちた」孤立オブジェクトが必ず出るためです。

```
1. ログイン済み・投稿の所有者であることをサーバーで確認
2. multipart で受け取る（1枚 5MB まで、投稿あたり 10枚まで）
3. ★ファイル名を信用しない。★ Content-Type も信用しない
4. 先頭バイトのシグネチャで実体を判定（JPEG / PNG / WebP のみ。SVG は拒否）
5. 縦横の上限を検査（JPEG は SOF、PNG は IHDR、WebP は VP8/VP8L/VP8X を読む）
6. メタデータを除去
   ・JPEG: APPn と COM セグメントを落とす（Exif の GPS ごと消える）
   ・PNG : eXIf / tEXt / iTXt / zTXt を落とす
   ・WebP: EXIF / XMP チャンクを落とす
7. ULID から推測困難なオブジェクトキーを作って R2 binding で PUT
8. listing_images に記録（object_key は一意）
```

**配信**は `/media/:objectKey` の Worker 経由。
- 公開中の投稿の画像だけを誰にでも配る
- 下書き・決済待ちの画像は**所有者と管理者だけ**
- `Content-Type` はサーバーが決めた値だけを返す（保存時の判定結果）
- `X-Content-Type-Options: nosniff` と `Content-Disposition: inline` を付ける
- R2 のキーや署名付き URL をログへ出さない

**削除**は即時に物理削除せず `purge_after` を立て、定期処理がまとめて消します。
孤立画像（どの投稿にも紐づかないもの）も同じ処理で回収します。

---

## 9. セキュリティ対策

| 対策 | 実装 |
|---|---|
| 入力検証 | すべて Zod でサーバー側。クライアント側の検証は体験のためだけ |
| SQL インジェクション | Drizzle のプレースホルダ。生 SQL も `sql` テンプレートでパラメータ化。LIKE のメタ文字はエスケープ |
| XSS | React の既定エスケープ。`dangerouslySetInnerHTML` を使わない。メッセージは常にプレーンテキスト |
| CSRF | Origin/Referer の**完全一致**照合 ＋ 署名付き二重送信トークン。両方必須 |
| IDOR | ULID ＋ 全 API での所有者確認。他人のものは **404**（403 だと存在が分かる） |
| SSRF | 外部への fetch 先は Stripe / Resend / Turnstile の定数 URL のみ。利用者入力から URL を組み立てない |
| オープンリダイレクト | 戻り先はパスのみ受け付け、絶対URLを拒否 |
| セッション固定 | ログインのたびに新しいセッション行とトークン |
| クリックジャッキング | `X-Frame-Options: DENY` ＋ CSP `frame-ancestors 'none'` |
| CSP | nonce 方式。`'unsafe-inline'` を script-src に入れない |
| HSTS | `max-age=31536000; includeSubDomains`（`preload` は付けない） |
| レート制限 | アプリ側（`rate_limits` 表）。エッジの Rate limiting rules は Free だとゾーンで1枠しかなく当てにできない |
| ボット対策 | Turnstile。**共有ウィジェット** ＋ hostname 完全一致照合 ＋ fail-close |
| 権限 | `guards.server.ts` を全ローダー・アクションで通す |
| 監査 | 管理操作は `admin_actions` と `audit_logs` に必ず記録。理由を必須にする |
| ログ | 構造化 ＋ 鍵名によるマスキング。メールアドレスは `maskEmail` を通す |
| エラー | 利用者向け文言と内部詳細を分離。スタックトレースを本番で出さない |

---

## 10. 実装フェーズ

| # | 内容 | 状態 |
|---|---|---|
| 1 | 現状調査・要件整理 | 完了 |
| 2 | 基盤（RR8 + Workers + Vite + Tailwind + TS strict） | 完了（build 通過を実測） |
| 3 | DB スキーマ・マイグレーション・seed | スキーマとマイグレーション生成まで完了 |
| 4 | コア層（DB・暗号・セッション・CSRF・Turnstile・レート制限・ヘッダ） | 完了 |
| 5 | 認証 | 着手中 |
| 6 | 投稿（5カテゴリ・遷移・検索） | 着手中 |
| 7 | R2 画像 | 未 |
| 8 | Stripe 決済 | 未 |
| 9 | メッセージ・通報・ブロック | 未 |
| 10 | 管理画面 | 未 |
| 11 | 公開画面・SEO・法務・メール | 未 |
| 12 | テスト（単体・統合・E2E）・CI | 未 |
| 13 | 文書 | 未 |

各フェーズの終わりに `pnpm run check`（lint → typecheck → 単体 → 統合 → build）を通します。

---

## 11. 未確定事項

1. **メール送信ドメインの from。** `notice@rewrite-co.com` を使う前提で書いていますが、
   Resend 側でこのサービス用の from を分けるかは未確認です。
2. **Stripe アカウント。** 構築ルール §6 は「サービスごとに別アカウント」を求めています。
   このサービス用のアカウントはまだ存在しません（人間の作業）。
3. **市区町村マスタの範囲。** seed には全都道府県と、政令市・特別区を含む主要市区町村を
   入れます。全1,700余の自治体を入れるかは運用判断です（データ出典と更新手順を
   OPERATIONS.md に書きます）。
4. **掲載期限の既定値。** 30日としています。7/14/30/60/90 から選べる形です。
5. **決済失敗時の下書き復帰の猶予。** Checkout Session の失効（既定24時間）で
   `draft` へ戻す実装にしていますが、cron の頻度は未決定です。

---

## 12. 本番公開前に人間が設定する項目

**私が代行しない・できないもの**です。詳細な手順は DEPLOYMENT.md にあります。

| # | 項目 | 理由 |
|---|---|---|
| 1 | Neon プロジェクトと DB（dev / preview / production を分ける）の作成 | `neonctl` が未認証。課金アカウントの操作 |
| 2 | アプリ用 DB ロールの作成（**DDL 権限を与えない**） | 権限設計は運用判断 |
| 3 | R2 バケット3つの作成（`nakadachi-media-dev` / `-preview` / `nakadachi-media`） | 実施可能だが課金対象リソースの作成 |
| 4 | Cloudflare Workers プロジェクトとカスタムドメインの割り当て | 同上 |
| 5 | **このサービス専用の Stripe アカウント**作成、テストモードでの商品・Webhook 登録 | 事業者としての契約 |
| 6 | Resend の送信ドメイン認証（SPF / DKIM / DMARC） | DNS の変更 |
| 7 | Secrets 10項目の投入（`wrangler secret put`） | 値を私に渡さないこと |
| 8 | 初期管理者（`h.takahashi0923@gmail.com`）の作成 | `scripts/create-admin.ts` の手順あり |
| 9 | GitHub の Secret Scanning / Push Protection の有効化 | リポジトリ設定 |
| 10 | `rewrite-uptime/src/targets.js` への監視対象追加 | 別リポジトリ |
| 11 | `rewrite-co.com` トップページへのカード追加 | 別リポジトリ |
| 12 | **規約文面の法務確認** | ひな型のまま公開しないこと |

> **秘密情報の受け渡しについて。** 値をチャットやソースコードへ貼らないでください。
> `wrangler secret put` を対話で実行して貼り付けるか、`pnpm run secrets:put` を
> 使ってください。★PowerShell のパイプで渡すと BOM と CRLF が付いて値が壊れます。★
> DB の接続文字列なら接続エラーで露見しますが、API キーは黙って認証エラーに
> なるだけで気づけません。
