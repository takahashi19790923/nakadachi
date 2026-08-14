# ルート仕様

定義は [`app/routes.ts`](../app/routes.ts)。ファイル名からの自動生成ではなく
明示列挙にしています（URL は外から見える約束なので、ファイルを動かしただけで
変わってほしくないため）。

凡例：

- **索引** — `索引` は検索エンジンに載せる、`noindex` は載せない
- **権限** — `公開` / `要ログイン` / `所有者` / `管理者+3層`

---

## 公開画面

| メソッド | パス | 権限 | 索引 | 内容 |
|---|---|---|---|---|
| GET | `/` | 公開 | 索引 | トップ。新着・カテゴリ・地域 |
| GET | `/categories` | 公開 | 索引 | カテゴリ一覧 |
| GET | `/c/:categorySlug` | 公開 | 索引 | カテゴリ別。未知の slug は 404 |
| GET | `/area/:prefectureCode` | 公開 | 索引 | 都道府県別 |
| GET | `/area/:prefectureCode/:cityCode` | 公開 | 索引 | 市区町村別。親子関係を検証 |
| GET | `/search` | 公開 | **noindex** | 検索。条件の組み合わせで薄い重複ページが増えるため |
| GET | `/listings/:listingId` | 公開 | 索引 | 投稿詳細。**公開中以外は 404** |
| GET | `/media/:objectKey` | 条件付き | — | 画像。下書きは所有者と管理者のみ |

### 規約・ご案内

| メソッド | パス | 索引 | 内容 |
|---|---|---|---|
| GET | `/legal/terms` | 索引 | 利用規約（ひな型） |
| GET | `/legal/privacy` | 索引 | プライバシーポリシー（ひな型） |
| GET | `/legal/tokushoho` | 索引 | 特定商取引法に基づく表記（ひな型） |
| GET | `/legal/prohibited` | 索引 | 禁止行為・禁止出品物 |
| GET | `/guide/safety` | 索引 | 安全な取引のためのガイド |
| GET/POST | `/contact` | 索引 | お問い合わせ（Turnstile あり） |

> 運営者情報と Cookie ポリシーはこのサービスに持たせず、
> `https://rewrite-co.com/legal/` へ絶対URLで参照しています。

---

## 認証

| メソッド | パス | 権限 | 索引 | 内容 |
|---|---|---|---|---|
| GET/POST | `/login` | 公開 | noindex | アドレス入力。**Turnstile → CSRF → Zod の順** |
| GET/POST | `/login/verify` | 公開 | noindex | 6桁コードの入力。アドレスは短命 Cookie で渡す |
| GET | `/login/link` | 公開 | noindex | メールのリンク。**GET で状態が変わる唯一の経路** |
| GET | `/login/error` | 公開 | noindex | 失敗の案内。理由を細かく出さない |
| POST | `/logout` | 要ログイン | — | **POST のみ。** DB 側でも失効させる |

---

## 利用者向け（すべて noindex）

| メソッド | パス | 権限 | 内容 |
|---|---|---|---|
| GET | `/mypage` | 要ログイン | 件数と入口 |
| GET/POST | `/mypage/profile` | 要ログイン | 表示名・自己紹介・通知設定 |
| GET | `/mypage/drafts` | 要ログイン | 下書き・決済待ち |
| GET | `/mypage/published` | 要ログイン | 公開中 |
| GET | `/mypage/finished` | 要ログイン | 掲載終了・期限切れ・非公開 |
| GET | `/mypage/favorites` | 要ログイン | お気に入り |
| GET | `/mypage/messages` | 要ログイン | 会話の一覧 |
| GET/POST | `/mypage/messages/:threadId` | **当事者のみ** | 会話。当事者以外は 404 |
| GET | `/mypage/reports` | 要ログイン | 自分が出した通報 |
| GET | `/mypage/payments` | 要ログイン | 決済履歴 |
| GET/POST | `/mypage/delete` | 要ログイン | 退会。確認文字列の入力が必要 |

## 投稿

| メソッド | パス | 権限 | 内容 |
|---|---|---|---|
| GET/POST | `/listings/new` | 要ログイン | カテゴリ選択 → フォーム。**下書き保存は無料** |
| GET/POST | `/listings/:id/edit` | 所有者 | 編集。**公開中の編集で再課金しない** |
| GET | `/listings/:id/confirm` | 所有者 | 確認と決済への入口。110円を明示 |
| POST | `/listings/:id/checkout` | 所有者 | **POST のみ。** 金額はサーバー側の定数 |
| GET | `/listings/:id/pending` | 所有者 | 決済完了待ち。**★ここでは状態を変えない★** |
| GET/POST | `/listings/:id/close` | 所有者 | 掲載終了・削除 |
| GET/POST | `/listings/:id/images` | 所有者 | 写真の追加・削除 |
| GET/POST | `/listings/:id/contact` | 要ログイン | 会話を開く |
| POST | `/listings/:id/favorite` | 要ログイン | お気に入りの切り替え。**POST のみ** |
| GET/POST | `/listings/:id/report` | 要ログイン | 通報 |
| POST | `/users/:userId/block` | 要ログイン | ブロック。**相手に知らせない** |

---

## 管理画面（すべて noindex・管理者+3層）

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/admin` | ダッシュボード |
| GET/POST | `/admin/gate` | **第2層（メール再確認）と第3層（共通の資格情報）** |
| GET/POST | `/admin/users` | 利用者。停止すると全セッションを失効させる |
| GET | `/admin/listings` | 投稿一覧。状態で絞れる |
| GET/POST | `/admin/listings/:id` | 非公開・却下・復帰。**理由の入力は必須** |
| GET/POST | `/admin/reports` | 通報対応 |
| GET/POST | `/admin/payments` | 決済状況と**返金の実行** |
| GET | `/admin/audit` | 監査ログ |
| GET/POST | `/admin/banned-words` | 禁止ワード |

> 権限が無い場合は **404** を返します（403 だと管理画面の所在が分かるため）。

---

## 機械向け

| メソッド | パス | 認証 | 内容 |
|---|---|---|---|
| GET | `/api/health` | 不要 | 真偽と所要ミリ秒だけ。DB まで触る |
| GET | `/api/config` | 不要 | 設定の反映確認。**値そのものは返さない** |
| POST | `/api/stripe/webhook` | **署名検証** | **決済成功の正。** CSRF も Origin も要求しない |
| GET | `/robots.txt` | 不要 | `text/plain` で返す |
| GET | `/sitemap.xml` | 不要 | **公開中の投稿だけ** |

---

## その他

| パス | 内容 |
|---|---|
| `*` | **404 を返す。** SPA フォールバックで全パスに 200 を返さない |

---

## 状態を変える操作の共通手順

```
1. Origin / Referer の完全一致照合          （ヘッダだけを見るので安い）
2. Turnstile（フォームによる）              ★入力検証より前★
3. CSRF トークンの照合
4. レート制限
5. Zod による検証
6. 権限の確認
7. サービス層の呼び出し
```

**2 を後ろに置かないでください。** 形の崩れた入力が先に弾かれ、
外形上「ボット検査を通っていない」のと区別がつかなくなります。

例外は `/api/stripe/webhook` です。外部からの正当な POST なので、
署名検証だけを行い、Origin も CSRF トークンも要求しません。
