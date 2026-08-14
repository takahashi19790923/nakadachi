# アーキテクチャ

---

## 1. 全体像

```
ブラウザ
   │  HTTPS
   ▼
Cloudflare Workers（workerd）
   ├─ workers/app.ts        入口。ヘッダ・nonce・CSRF の対・正規ホスト
   │     │
   │     ├─ /api/health     React Router を通さず直接応答（監視用）
   │     └─ それ以外        React Router へ委譲
   │
   ├─ app/entry.server.tsx  SSR。nonce を React コンテキストで配る
   ├─ app/routes/**         ローダー / アクション / 画面
   ├─ app/server/**         サーバー専用（サービス層・リポジトリ層）
   └─ app/domain/**         純粋なロジック（クライアントからも import 可）
         │
         ├──────────────► Neon PostgreSQL（HTTP / WebSocket）
         ├──────────────► Cloudflare R2（binding。アクセスキー無し）
         ├──────────────► Stripe API（HTTPS）
         └──────────────► Resend API（HTTPS）
```

---

## 2. 層の分け方

| 層 | 置き場所 | 役割 | 禁止事項 |
|---|---|---|---|
| domain | `app/domain/` | 純粋なロジック。金額・状態遷移・検証・画像解析 | I/O 一切 |
| repository | `app/server/repositories/` | データアクセス | ビジネス判断、状態遷移 |
| service | `app/server/services/` | ビジネスロジック。決済・メール・画像・投稿・メッセージ | 画面の都合 |
| route | `app/routes/` | 入出力の変換、権限確認、画面 | ビジネスロジック |

### クライアントとサーバーの分離

`*.server.ts` という命名で機械的に保証しています。React Router は
`loader` / `action` / `middleware` / `headers` からしかサーバーコードを
取り除かないため、`meta` や画面部品がサーバーモジュールを辿ると
**ビルドが落ちます**。

**この「落ちる」が防御です。** 回避せず、型と定数を `app/domain/` へ出します。
実際に3回落ちて、次のものを移しました。

| 移したもの | 移した先 | なぜ |
|---|---|---|
| `buildPageMeta` ほか | `app/domain/seo.ts` | `meta` から呼ぶため |
| `ListingSummary` 型 | `app/domain/listing-types.ts` | カード部品が型を import する |
| `buildPageHref` / `PER_PAGE` | `app/domain/list-params.ts` | ページ送り部品が使う |
| 画像の上限値 | `app/domain/image-limits.ts` | 画面の案内文が使う |
| 退会の猶予日数 | `app/domain/account.ts` | 退会画面が使う |

---

## 3. リクエストの流れ

```
1. workers/app.ts
   ├─ env を検証（足りなければ 503。undefined を配らない）
   ├─ 正規ホストでなければ転送（GET/HEAD は 301、他は 308）
   ├─ リクエストごとの DB クライアントを用意（★遅延生成★）
   ├─ CSP の nonce を生成
   ├─ CSRF の対（Cookie と署名付きトークン）を用意
   └─ RouterContextProvider に詰めて React Router へ

2. ローダー / アクション
   ├─ getApp(context) で値を取り出す
   ├─ 権限を確認（guards.server.ts）
   ├─ 状態を変える操作なら
   │     ① Origin 照合 → ② Turnstile → ③ CSRF トークン → ④ Zod
   └─ サービス層を呼ぶ

3. 応答
   ├─ セキュリティヘッダーを付ける（CSP に nonce を埋める）
   ├─ 新規なら CSRF の Cookie を付ける
   └─ ctx.waitUntil で DB 接続を畳む
```

### 検証の順序が大事な理由

**Turnstile は入力検証より前**に置いています。後ろに置くと、形の崩れた入力が
先に `bad_request` で返り、外形上「ボット検査を通っていない」のと区別が
つきません。実際に、この順序の違いを fail-open と誤診した事例があります。

---

## 4. DB クライアント

### リクエストごとに作る

Cloudflare Workers は **I/O オブジェクトのリクエスト跨ぎを禁止**しています。
モジュール変数や `globalThis` にキャッシュすると、2回目以降のリクエストで

```
Cannot perform I/O on behalf of a different request.
```

が出て 500 になります。**同じ isolate に当たったリクエストだけが落ちる**ので
「10回中2回だけ 500」のような分かりにくい出方をします。
**ローカルでは一度も再現しません。**

`createRequestDb(env)` がリクエストごとにプールを作り、
`ctx.waitUntil(dispose())` で畳みます。

### 遅延生成にしている理由

`getDb` は**関数のまま**渡しています。呼ばれて初めて接続を作ります。

先に作ってしまうと、Cookie を持たない訪問者（規約ページを読んでいるだけの人）
にも毎回 DB 接続が作られます。無駄なだけでなく、`DATABASE_URL` が無い環境では
**規約ページすら 500** になります（ローカルの初回起動と E2E で実際に踏みました）。

### HTTP と WebSocket

`neonConfig.poolQueryViaFetch = true` にしてあります。単発の問い合わせは
HTTP で投げ、トランザクション（`pool.connect`）のときだけ WebSocket が開きます。
公開ページは読み取りしかしないので、毎回 WebSocket を張ると往復が丸ごと無駄です。

---

## 5. データモデルの判断

### 金額を1つの列にまとめた

`listings.price_jpy` は「その投稿を代表する金額（円）」です。
売買なら価格、貸出なら料金、求人なら給与の下限。単位は `price_unit`。

カテゴリごとに列を分けると「価格順に並べる」がカテゴリ分岐になり、
片方を直し忘れた瞬間に並び順が壊れます。

### カテゴリ固有項目

検索・並べ替えに使う項目は**列**に、表示するだけの補助情報のみ
`listing_category_details.extra`（JSONB）に入れています。
すべてを JSONB にすると索引が張れず、すべてを列にするとカテゴリを増やす
たびにマイグレーションが要ります。

### 決済記録の参照を NULL 可にした

`payments.listing_id` と `user_id` は `ON DELETE SET NULL` です。

決済の記録は法令上の保存義務があるため退会しても消せません。一方で
「消したのに個人が特定できる」状態も作れません。参照だけを外し、
金額・日時・決済事業者側の識別子を残します。

`NOT NULL` のままだと、退会処理が外部キーで**必ず失敗**します。
そして `try/catch` に握られて誰も気づかない、という壊れ方をします。

---

## 6. 検索の限界

日本語は語の区切りが無く、PostgreSQL の `to_tsvector` の既定辞書では
実用になりません（「東京都」が1語として扱われず、部分一致もできない）。

現在の実装：
- 生成列 `search_text`（タイトル＋本文＋地域メモ）
- `pg_trgm` の GIN 索引
- `ILIKE '%キーワード%'` で引く

**限界を承知の上での MVP の選択です。**

| 限界 | 影響 |
|---|---|
| 2文字以下の検索語では索引が効かない | 「本」「車」などが遅い |
| 表記ゆれを吸収しない | 「じてんしゃ」で「自転車」が出ない |
| 関連度順に並べられない | 新着順・価格順のみ |

**改善する場合の選択肢：**

1. **pgroonga / pg_bigm** — 日本語の全文検索として素直だが、**Neon では使えない**
   （拡張が提供されていない）。自前の PostgreSQL へ移す必要がある
2. **外部の検索サービス**（Meilisearch / Typesense / Algolia）—
   投稿の更新時に同期する処理が要る
3. **読み仮名の列を足す** — 表記ゆれの一部は吸収できるが、入力の手間が増える

件数が数千件を超えるまでは現状で足ります。超えたら 2 を検討してください。

---

## 7. 性能上の判断

| 箇所 | 判断 | なぜ |
|---|---|---|
| 一覧の写真 | ID をまとめて1回で引く | 行ごとに引くと、ネットワーク越しの DB では件数に比例して破綻する |
| セッション | リクエスト内で1回だけ引く（`WeakMap`） | 1画面で複数のローダーが動くため |
| 閲覧数 | `ctx.waitUntil` で更新 | 応答を待たせない。失敗しても画面を壊さない |
| 通知メール | 同上 | 送信の失敗で本処理を巻き戻さない |
| 検索のページ番号 | 200 ページで打ち切る | 深いページは索引を使っても重く、意味も薄い |
| メッセージ通知 | 1時間単位でまとめる | 会話中に何十通も届くと通知そのものが無視される |

---

## 8. 環境の分離

| | development | preview | production |
|---|---|---|---|
| Workers | ローカル | `nakadachi-preview` | `nakadachi` |
| ドメイン | localhost:5273 | `nakadachi-preview.rewrite-co.com` | `nakadachi.rewrite-co.com` |
| DB | Neon 開発用 | Neon preview 用 | Neon 本番用 |
| R2 | `nakadachi-media-dev` | `-preview` | `nakadachi-media` |
| Stripe | テストモード | テストモード | 本番モード |
| Turnstile | テスト鍵（常に成功） | 共有ウィジェット | 共有ウィジェット |
| Cookie | `nakadachi_session` | `__Host-` 付き | `__Host-` 付き |

`wrangler.jsonc` の named environment は **vars を継承しません**。
トップレベルにだけ書くと `--env production` で vars が空になり、
`APP_ORIGIN` が undefined のまま動きます。重複を承知で全部書いています。

---

## 9. 意図的にやっていないこと

| やっていないこと | 理由 |
|---|---|
| WebSocket でのリアルタイム更新 | MVP に不要。HTTP とポーリングで足りる |
| 画像の変換・リサイズ | R2 に原本を置くだけ。Images binding は費用と複雑さが見合わない |
| デポジットの預かり | 資金決済法の規制対象になりうる。当事者間の取り決めとして表示するだけ |
| 評価・レビュー機能 | 悪用（報復レビュー）への対応が別途要る。MVP の範囲外 |
| 多言語対応 | 日本国内向けのため |
| Stripe / Resend の公式 SDK | Webhook の署名検証をネットワーク無しで単体テストしたい。バンドルも小さくなる |
| エッジのレート制限 | Free プランではゾーン全体で1つしか持てず、他サービスと取り合いになる |
