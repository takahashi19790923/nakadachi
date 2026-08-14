# 運用

---

## 1. 定期処理

```bash
node --experimental-strip-types scripts/cron.ts <task>
```

| task | 内容 | 推奨する頻度 |
|---|---|---|
| `expire-listings` | 掲載期限を過ぎた投稿を `expired` にする | 1時間ごと |
| `notify-expiring` | 期限の3日前に投稿者へ知らせる | 1日1回 |
| `purge-accounts` | **30日を過ぎた退会依頼を実際に実行する** | 1日1回 |
| `cleanup` | 期限切れのセッション・トークン・レート制限を掃除する | 1日1回 |
| `all` | 上のすべて | — |

R2 の掃除（`purge-media`）だけは binding が要るため Node からは実行できません。
Workers 側の cron trigger、または管理画面からの操作として足してください。

### 実行方法

**GitHub Actions のスケジュール実行**を推奨します。
`DATABASE_URL`（アプリ用ロール）と鍵を Environment Secrets へ置き、
`production` environment に承認ルールを設定してください。

`rewrite-uptime` のような別 Worker の Cron Trigger から HTTP で叩く形にする
場合は、その口に必ず認証をかけてください（誰でも叩ける口にしない）。

> **`purge-accounts` は失敗すると終了コード1で落ちます。**
> 「消えたつもり」を作らないためです。**失敗を無視しないでください。**

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

### 目視で見るもの

| 何を | どこで | どうなったら対応 |
|---|---|---|
| 未対応の通報 | 管理ダッシュボード | 1件でも溜まったら |
| Webhook の失敗 | `payment_webhook_events.status = 'failed'` | 1件でも |
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
| DB | **Neon の PITR**（Point-in-Time Restore） | プランに依存（無料は24時間、有料は7〜30日） |
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
