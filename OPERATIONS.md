# 運用

---

## 1. 定期処理

**Workers の Cron Trigger で自動実行されます。** 手で流す必要はありません。
設定は `wrangler.jsonc` の `triggers.crons`、中身は `app/server/cron.server.ts`。

| 時刻（UTC / JST） | 処理 | 内容 |
|---|---|---|
| 毎時 00分 | `expireListings` | 掲載期限を過ぎた投稿を `expired` にする |
| 〃 | `reconcilePayments` | **決済と掲載の食い違いを探し、あれば運営者へメール** |
| 19:20 / **04:20** | `exportDatabase` / `pruneBackups` | 月曜だけ。DB を R2 へ書き出し、8世代より古いものを消す |
| 〃 | `purgeAccounts` | **30日を過ぎた退会依頼を実際に実行する** |
| 〃 | `purgeAccessRecords` | **保存期間(183日)を過ぎた発信者情報を消す** |
| 〃 | `markEndedImages` | 終了から90日の掲載の写真に削除待ちの印をつける |
| 〃 | `purgeDeletedImages` | 削除待ちの画像を R2 から消す |
| 〃 | `purgeEndedListings` | 終了から180日の掲載を消す（写真が無いものだけ） |
| 〃 | `purgeWebhookEvents` / `purgeEmailLogs` | 運用データを90日で消す |
| 〃 | `purgeResolvedReports` | 対応済みの通報を180日で消す |
| 〃 | `purgeOldPayments` | **決済記録を7年で消す（帳簿）** |
| 〃 | `notifyExpiring` | 期限の3日前に投稿者へ知らせる |
| 〃 | `purgeSessions` / `purgeTokens` / `purgeRateLimits` | 期限切れの掃除 |

### 保持期間

値は `app/domain/retention.ts` に集めてあります。

| 対象 | 保持 | 起点 |
|---|---|---|
| 写真 | 90日 | 掲載終了 |
| 掲載本文・詳細・やり取り | 180日 | 掲載終了 |
| Webhookイベント・メール送信ログ | 90日 | 受信・送信 |
| 対応済みの通報 | 180日 | 対応完了 |
| 発信者情報 | 183日 | 記録 |
| **決済記録** | **7年（帳簿書類）** | 作成 |
| 監査ログ | 消さない | — |

★写真 → 掲載 の順で消すこと。★ 掲載を消すと `listing_images` は連鎖削除
されますが、**R2 のオブジェクトは消えません。** 行だけ消えて実体が残ると、
どこからも参照されない課金対象が永久に残り、誰も気づけません。
`purgeEndedListings` に「写真が1枚も残っていないこと」を条件として
入れてあるので、写真の掃除が落ちた日は掲載の削除も自動的に見送られます。

`suspended`（返金・係争・管理者の停止）は期間では消しません。経緯を
追えなくなるためです。消す場合は管理画面から `deleted` にしてください。

日次は**利用者に告知した削除を先に**実行します。実行時間の上限に当たっても、
約束したものが優先して走るようにするためです。

### 見かた

結果は Worker のログに1行で出ます。

```bash
npx wrangler tail nakadachi-production --format pretty
```

```
cron finished  cron=20 19 * * *  purgeAccounts=0 purgeAccessRecords=12 ...
```

★件数が数字ではなく `failed` になっていたら、その処理が落ちています。★
0件と失敗を区別できるようにしてあります。1つ落ちても残りは走ります。

### 手で流したいとき

```bash
npx wrangler dev --test-scheduled
```

別のターミナルから `curl "http://localhost:8787/__scheduled?cron=20+19+*+*+*"`。

> **⚠ 2026-08-16 まで、定期処理は1度も走っていませんでした。**
> `scripts/cron.ts` に書いてはあったものの、`~/` 別名を使うモジュールを
> Node が読めず起動すらせず（`ERR_MODULE_NOT_FOUND`）、しかも起動する設定が
> どこにもありませんでした。**「30日後に削除します」「183日で削除します」と
> 告知しながら、実際には消していない状態でした。**
>
> 同じことを繰り返さないよう、`test-integration/erasure.test.ts` に
> **入口から呼ぶ**検査を置いてあります。個々の削除関数だけを検査していると、
> 呼び出す側が壊れていることに気づけません（実際そうなっていました）。

---

## 2. 監視

### `/api/health`

```
GET /api/health
→ 200 {"ok":true,"db":true,"ms":42}
→ 503 {"ok":false,"db":false,"ms":5001}
```

DB まで実際に触ります。返すのは真偽と所要ミリ秒だけで、
**利用者数や設定値のような事業情報は出しません**（誰でも叩ける前提）。

`rewrite-uptime/src/targets.js` に追加してください。

> **HTML の 200 だけを見る監視は、DB が死んでいる状態を「正常」と誤判定します。**

### `/api/config`

設定の反映を確認する口です。**秘密の値そのものは返しません。**
「直したがデプロイし忘れた」をここで捕まえます。

### 決済の突き合わせ（毎時、自動）

★いちばん怖い壊れ方は「決済が成功しているのに掲載が出ない」。★
Stripe 側は入金成功で終わり、こちらも Webhook に 200 を返して終わります。
**どちらの画面にもエラーが出ません。** 利用者は110円払ったまま黙って去ります。
2026-08-16 に、原因の異なる3つでこれを実際に作りました。

直したうえで、それでも起きたときに人が気づける経路を `reconcilePayments`
（`app/server/services/payment/reconcile-service.server.ts`）に置いてあります。

| 見つけるもの | 条件 |
|---|---|
| `paid_not_published` | 決済成立から**60分**過ぎても `listings.published_at` が空 |
| `refunded_but_live` | 全額返金済みなのに `listings.status = 'published'` |

見つかると **`EMAIL_REPLY_TO` 宛に1件につき1通**届きます（件名 `[nakadachi][ops]`）。
毎時鳴り続けると慣れて読まなくなるため、冪等キーで1回に抑えています。
**メールが送れなくても Worker のログには必ず残ります。**

> `status` ではなく `published_at` で判定しています。公開後に本人が掲載終了
> した投稿は `closed` になり、`status` だけを見ると取り残しと区別がつきません。
> ここを間違えると正常な投稿すべてで警報が鳴り、本物が埋もれます。

### 目視で見るもの

| 何を | どこで | どうなったら対応 |
|---|---|---|
| 未対応の通報 | 管理ダッシュボード | 1件でも溜まったら |
| Webhook の失敗 | 管理ダッシュボード（上部に警告） | 1件でも |
| メール送信の失敗 | `email_delivery_logs.status = 'failed'` | 続くようなら鍵とドメイン認証を確認 |
| 決済待ちのまま滞留 | `listings.status = 'payment_pending'` が長時間 | Webhook が届いているか確認 |

```sql
-- Webhook の失敗（直近24時間）
select event_type, error_message, received_at
from payment_webhook_events
where status = 'failed' and received_at > now() - interval '1 day'
order by received_at desc;

-- 決済待ちのまま2時間以上のもの
select id, title, updated_at from listings
where status in ('payment_pending', 'payment_processing')
  and updated_at < now() - interval '2 hours';

-- メール送信の失敗
select template, error_code, count(*) from email_delivery_logs
where status = 'failed' group by template, error_code;
```

---

## 3. バックアップと復旧

### バックアップ

| 対象 | 方法 | 保持 |
|---|---|---|
| DB | **Neon の PITR**（Point-in-Time Restore） | プランに依存。**本番（Free）は 6時間**（`history_retention_seconds: 21600` を 2026-08-17 に API で実測。「24時間」ではない） |
| DB | 週1回の論理バックアップ（下記） | 手元または別のストレージで90日 |
| R2 | バージョニングは既定で無効 | 下記の注意 |
| コード | GitHub | — |
| 秘密情報 | 個人用 Vault | — |

**Neon の PITR は「保持期間内なら任意の時点へ戻せる」機能です。**
プランごとの保持期間を確認し、それより長い保護が必要なら論理バックアップを
併用してください。

```bash
# 週1回。★出力ファイルは .gitignore 済みだが、置き場所に注意★
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges \
  --file="nakadachi-$(date +%Y%m%d).dump"
```

> **このダンプには利用者の暗号化済みメールアドレスと投稿の内容が入ります。**
> 暗号化鍵が別に管理されているとはいえ、**個人情報を含むファイル**として
> 扱ってください。共有ストレージへ平置きしないこと。

**R2 について。** 投稿の写真は R2 にしかありません。
論理削除（`purge_after`）の猶予が30日あるので誤操作からは戻せますが、
**バケットごと失うと復旧できません。** 重要度に応じて、
R2 のバージョニングか別リージョンへの複製を検討してください。

### 復旧

#### DB を時点復旧する

1. **まずアプリを止める**（Workers のルートを外す、またはメンテナンス応答にする）
2. Neon のコンソールで復旧先の時点を選び、**新しいブランチとして復元する**
3. 復元先で内容を確認する（`listings` と `payments` の件数）
4. `DATABASE_URL` を復元先へ向ける（Secret を投入し直してデプロイ）
5. `/api/health` を10回確認する
6. **決済との整合を確認する**（下記）

#### 復旧後に必ず確認すること

DB を戻すと、**戻した時点より後の決済が DB から消えます。**
Stripe 側には記録が残っているため、食い違いが生じます。

```sql
-- 復旧時点より後に Stripe で成立した決済を、Stripe の管理画面と突き合わせる
select checkout_session_id, amount_jpy, paid_at
from payments
where paid_at > '<復旧時点>'
order by paid_at;
```

Stripe にあって DB に無い決済が見つかったら：

1. 該当の投稿が公開されているか確認する
2. 公開されていなければ、Stripe から該当イベントを**再送**する
   （ダッシュボード → Developers → Webhooks → 該当イベント → Resend）
3. `payment_webhook_events` に `processed` で入ることを確認する

**手作業で `listings.status` を書き換えないでください。**
状態遷移の記録が残らず、あとから追えなくなります。

---

## 4. 地域マスタの更新

市町村合併などで自治体が変わったとき。

> **★行を削除しないでください。★** 過去の投稿が `locations.code` を
> 外部キーで参照しています。消すと投稿ごと壊れます。

1. `app/db/seed/locations.ts` に新しい行を足す
2. 無くなった自治体は `is_active` を `false` にする（SQL で直接）
3. `pnpm run db:seed` を流す（既存の行は更新され、消えない）

```sql
-- 合併で無くなった自治体を隠す（消さない）
update locations set is_active = false, updated_at = now()
where code = '<コード>';
```

---

## 5. 禁止ワードの運用

管理画面（`/admin/banned-words`）から追加・削除します。

| 扱い | 挙動 | いつ使うか |
|---|---|---|
| 遮断（block） | 投稿・メッセージを拒否する | 明確に違法・危険なもの |
| 要確認（flag） | 通すが管理者の確認対象にする | 誤検知が出うるもの |

> **表記ゆれで簡単にすり抜けます。** 全角・記号・空白は正規化していますが、
> 「〇〇＠ぐーぐる」のような書き方は検出できません。
> **通報と目視と併用する前提の、最初の網でしかありません。**

初期値は「明確に違法な取引を示す語」だけにしてあります。
**露骨な語や差別的な語の一覧をリポジトリに置かないでください。**
運用のなかで管理画面から足してください。

---

## 6. 通報への対応

1. `/admin/reports` で内容を確認する
2. 必要なら `/admin/listings/<id>` で投稿を見る
3. 対応する（非公開・却下・利用停止）。**理由の入力は必須**
4. 通報を「対応済み」または「対応なし」にする。記録も必須

**会話の内容を確認する場合も、閲覧の事実が監査ログに残ります。**
正当な目的（通報対応）以外で他人の会話を読まないでください。

**非公開にしても掲載料は自動返金されません。**
返金が必要な場合は `/admin/payments` から明示的に処理します。

### 投稿を止めるのか、人を止めるのか

| 使う場面 | 操作 | 起きること |
|---|---|---|
| その投稿だけが問題 | `/admin/listings/<id>` → 非公開・却下 | その投稿が `suspended` / `rejected` になり公開ページから消える。投稿者へ理由つきで通知 |
| 人そのものが問題（詐欺など） | `/admin/users` → 利用を停止 | **その人の掲載がすべて公開ページから消え、ログイン中の端末もその場で切れる** |

利用停止では**掲載側の状態は変えません。** 公開判定のほうで投稿者が
停止中かを見ています（`publishedOnly()` は1か所だけ）。再開すれば掲載も
元に戻ります。掲載を `suspended` に書き換えてしまうと、どれが利用停止の
巻き添えで、どれが投稿そのものの問題だったのか区別できなくなるためです。

> **⚠ 2026-08-17 まで、利用を停止してもその人の掲載は公開されたままでした。**
> 詐欺の疑いで止めても掲載は誰にでも見え、本人はログインできないので
> 取り下げることもできず、問い合わせだけが届き続ける状態でした。
> `test-integration/admin-routes.test.ts` が管理画面の action を実際に
> 呼んで確かめています。**管理画面は事故が起きてから初めて使う画面なので、
> そのとき初めて壊れていると分かるのでは遅い。**

---

## 7. よくある障害

| 症状 | 最初に見るところ | よくある原因 |
|---|---|---|
| 全体が 503 | `/api/config` | Secret の投入漏れ、デプロイ忘れ |
| 10回中2回だけ 500 | Workers のログ | DB クライアントのリクエスト跨ぎ |
| ログインだけ 503 | `/api/config` の `turnstile` | `TURNSTILE_SECRET_KEY` の投入漏れ |
| 「確認に失敗しました」が全員に出る | Turnstile の設定 | サイトキーとシークレットが別ウィジェットの組み合わせ |
| 決済後に公開されない | `payment_webhook_events` | Webhook の URL が古い、イベントの購読漏れ |
| メールが届かない | `email_delivery_logs` | ドメイン認証、API キー |
| 画面は出るがボタンが反応しない | `e2e/hydration.spec.ts` | CSP の nonce。**curl では絶対に分からない** |
| 検索が遅い | 件数 | 2文字以下の語では索引が効かない（ARCHITECTURE.md §6） |

### 調べ方

```bash
# 直近のログ
pnpm exec wrangler tail --env production --format pretty

# エラーだけ
pnpm exec wrangler tail --env production --status error
```

> **ログに個人情報は出ません**（鍵名でマスキングし、メールアドレスは
> `maskEmail` を通しています）。障害の調査で足りない情報があれば、
> 個人情報を足すのではなく `requestId` で追ってください。

---

## 8. 引き継ぎのときに読むもの

1. [README.md](README.md) — セットアップと本番公開前チェックリスト
2. [ARCHITECTURE.md](ARCHITECTURE.md) — なぜこの形なのか
3. [SECURITY.md](SECURITY.md) — 秘密情報のローテーション手順
4. [THREAT_MODEL.md](THREAT_MODEL.md) — 何を受け入れているか
5. `新サービス構築ルール.md` §14 — このアカウント共通の罠
