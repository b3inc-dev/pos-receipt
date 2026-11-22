# DB では Pro なのに契約が無い店を調べる（レビュー P2-5）

## なぜ

前は `/app/plan/callback?plan=pro` を開くだけで DB の `Shop.planCode` が `pro` になった（穴。今はふさいだ。`DECISIONS.md` の D15）。
今の門番（`checkShopPlanAccess`）は、店がアプリを開いて契約を読めたときに `planCode` を契約の値へ直す。
でも、そのあとアプリを開いていない店は DB に `pro` が残る。そういう店を一覧にする。

**読むだけです。** DB にも Shopify にも書きません（`planCode` を直さない・トークンを新しくしない・契約を作らない）。
見つかった店をどうするか（そのままにする・Lite に戻す・店に連絡する）は T が決めます（連絡帳 #39 の「前の穴で Pro のままの店の扱い」）。

## T の動かし方（Render の Shell）

1. Render のダッシュボードで **公開用の `pos-receipt`**（Ciara 用の `pos-receipt-ciara` ではない）を開く。
2. 左の **Shell** を開く。
3. 次のどちらかを打つ。

```bash
npm run report:plan-mismatch
# tsx が入っていないと出たら:
npx --yes tsx@4 scripts/report-plan-mismatch.mjs
```

- 1 店だけ: `npm run report:plan-mismatch -- --shop=<店>.myshopify.com`
- JSON で: `npm run report:plan-mismatch -- --json`
- 結果はタブ区切りの表です。そのまま表計算に貼れます。
- `pos-receipt-ciara`（`APP_DISTRIBUTION=inhouse`）で打っても、「調べるものはありません」と出て何もしません。

## 何を見るか

| 判定 | 意味 |
|------|------|
| ずれ（Pro の契約なし） | 契約を読めたのに、有効な Pro の契約が無い。**T が扱いを決める店** |
| 読めない | 契約を読めなかった（理由の列を見る）。ずれとは言えない |
| 手で付けた unlimited | DB が `unlimited`（手で付けた例外）。ずれとは数えない |
| 例外（全機能の店） | `CUSTOM_APP_STORE_IDS` または開発ストア。門番が全機能にする店 |
| OK（Pro の契約あり） | 問題なし |

調べるのは DB の `planCode` が `pro` か `unlimited` の店だけです。プランの読み方は門番と同じ関数（`shopPlan.server.ts` の `planFromSubscriptions`）を使います。

## 契約の読み方

1. Partner API（`PARTNER_API_TOKEN`・`PARTNER_API_ORG_ID`・`PARTNER_API_APP_ID` がそろっているときだけ）。店のトークンが要らない。
   アプリの門番のスイッチ `PARTNER_API_SUBSCRIPTION_ENABLED` がオフでも、この診断だけは値を使って読む（スイッチは変えない）。
2. Partner で Pro が見えなかった店は、Admin API（DB の店のオフラインのトークン）でも読む。

読めない理由の例:

| 理由 | 意味 |
|------|------|
| `token_expired` | オフラインのトークンの期限が切れている（このアプリは期限つきのトークン）。新しくすると店のトークンが変わるので、この診断では新しくしない。Partner API の値を入れると読める |
| `no_offline_session` | DB に店のオフラインのトークンが無い（消した店など） |
| `admin_http_401` / `admin_http_403` | トークンが使えない（アプリを消した店など） |
| `admin_http_402_frozen` | 店が凍結されている |
| `partner_throttled` など | Partner API の失敗。少しおいてもう一度 |

## コード

- 本体: `scripts/lib/planMismatch.mjs`（テスト `scripts/lib/planMismatch.test.mjs`。`npm test` に入っている）
- 入口: `scripts/report-plan-mismatch.mjs`
