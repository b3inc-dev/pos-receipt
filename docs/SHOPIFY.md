# SHOPIFY — API・Webhook・メタフィールド・印字

コードと TOML で確認した Shopify 連携の現状です。

## 1. アプリ形態

| 項目 | 内容 |
|------|------|
| 埋め込み Admin アプリ | `embedded = true` |
| POS UI Extension | `extensions/pos-smart-grid`（複数 handle） |
| 公開／自社 | `shopify.app.public.toml` / `shopify.app.toml` |
| App Proxy | 会員証 `/apps/member-card`（自社用 toml） |

## 2. API バージョン

| 箇所 | バージョン |
|------|------------|
| Admin SDK（`app/shopify.server.ts`） | `ApiVersion.April26`（= `2026-04`） |
| Webhooks（`shopify.app.toml` / `shopify.app.public.toml`） | `api_version = "2026-04"` |
| POS Extension（`extensions/pos-smart-grid/shopify.extension.toml`） | `api_version = "2026-07"`（POS UI Extensions の版。Printing API に要る） |

Admin SDK と Webhook は同じ版にそろえる。`app/utils/apiVersionAlignment.test.ts` が片方だけ変えたときに落ちる。Webhook の版を変えるのは HIGH RISK（届く payload の形が変わる）ので、上げるときは別 PR で T の承認を取る。

POS 拡張の版は Admin API とは別の系列。POS の中から直接呼ぶ Admin GraphQL（`extensions/common/shopifyAdminGraphql.js` の `shopify:admin/api/graphql.json`）がどの Admin API の版で答えるかは、Shopify の公式文書で **未確認**（拡張の `api_version` に従うと見られるが、確かめていない）。

## 3. スコープ（自社用 toml 記載）

```
read_orders, read_locations, read_customers, read_gift_cards, read_products,
write_customers, write_app_proxy, write_draft_orders, write_orders
```

精算の order_based は draft orders + orders 更新（ノート・metafield）＋履行に依存。レガシー Gift Card 集計は `read_gift_cards`。

## 4. 利用している Shopify データ（精算・レシート関連）

| データ | 用途 |
|--------|------|
| Order（location_id 検索、transactions, refunds, lineItems, tags, note, tax, total） | 精算集計 |
| Order.retailLocation | 領収書ロケーション、注文検索フィルタ、返金帰属 |
| Discount allocations / VIP- codes | 割引・VIP 集計 |
| （staffMember on lineItems は読まない。`read_users` が要るため） | — |
| customAttributes | 取得のみ（精算・領収書 UI では未使用） |
| DraftOrder → Order（SETTLEMENT / INSPECTION） | order_based 印字用 |
| Fulfillment create（V2→フォールバック） | 精算注文クローズ |
| Gift Cards API（任意） | レガシー発行額加算 |
| Location | 同期・表示・printMode |

注文・ギフトカード検索（`query:`）の日時は、店舗タイムゾーンの 1 日（日本の店は日本時間 0:00〜23:59:59.999）を **UTC の Z 表記**にし、**値を二重引用符で囲んで**渡す（`app/utils/shopifySearchDate.ts` の `searchDateRange` / `searchDateCondition`。例: 2026-11-23 → `created_at:>="2026-11-22T15:00:00Z" created_at:<="2026-11-23T14:59:59.999Z"`）。開発ストア（2026-11-23）で、引用符なしの Z 表記は時刻が効かず範囲より前の注文が返り、引用符なしの `+09:00` は同日の注文を取りこぼした（Shopify 側の読み方は未確認）。精算・売上サマリー・販路は取ったあとに取引・返金・作成の時刻で正確な範囲に絞り直すので、検索が広すぎても数字は変わらない。
| Shop.ianaTimezone / plan.partnerDevelopment | 日次境界・フルアクセス判定 |

## 5. Webhook

| Topic | URI | 処理（コード） |
|-------|-----|----------------|
| `app/uninstalled` | `/webhooks/app/uninstalled` | アンインストール処理 |
| compliance（customers/data_request, customers/redact, shop/redact） | `/webhooks/compliance` | GDPR。`data_request` は DB 列挙＋根拠ログ後に 200（email/phone 非保存。開示は運用）。`customers/redact` は `ReceiptIssue.recipientName` と `SpecialRefundEvent.note` を `[redacted]` に対称化。詳細は `gdprCustomerDataRequest.server.ts` |
| `orders/updated` | `/webhooks/orders/updated` | 売上サマリー更新キュー + 返金計上 metafield 同期 |

## 6. メタフィールド

### 6.1 namespace `settlement`（精算注文）

定義: `settlementMetafieldDefinitions.server.ts`\
主な key: `period_label`, `location_label`, `as_of`, `version`, `total`, `refund_total`, `discounts`, `vip_points_used`, `tax`, `net_sales`, `tax_shopify`, `voucher_change`, `order_count`, `refund_count`, `item_count`, `payment_sections`\
追加書込: `settlement.uniq`, `settlement.copy_type`（inspection）

### 6.2 namespace `pos`（業務注文）

| key | 用途 |
|-----|------|
| `refund_aggregation_location_gid` | 返金の精算計上先 |
| `adjustments` | 特殊返金・商品券調整の記録（JSON・アプリが書く。精算と ciara-system が数える）。仕様は `docs/ORDER_ADJUSTMENTS_METAFIELD.md` |
| `adjustments_summary` | 上を人が読むための 1 行（表示用） |
| `special_refund_events` | 定義あり（JSON）。値は書かない（`adjustments` を使う） |
| `voucher_change_events` | 定義あり（JSON）。値は書かない（`adjustments` を使う） |
| `business_adjustments_version` | バージョン |

定義 ensure: OAuth / `POST /api/admin/settlement-metafields/ensure`

### 6.3 顧客の LINE ユーザー ID（LIFF 会員証が読む。書かない）

| 順 | 項目 | 書くアプリ |
|----|------|------------|
| 1 | `line_crm.line_user_id` | LINE CRM（Shop CRM for LINE）。定義も LINE CRM が作る |
| 2 | `socialplus.line` | SocialPlus。LINE CRM も店の設定がオンなら互換のために書く |

- 順番は環境変数 `MEMBER_CARD_LINE_ID_METAFIELDS`（例 `line_crm.line_user_id,socialplus.line`）で変えられる。空なら上の既定（DECISIONS の D14）。
- 顧客の LINE ユーザー ID は、並べた順で最初に値が入っている項目の値。値は生の `U…` でも JSON（`{"uid":"U…"}` など）でも読む。
- 見つけ方: タグ `line:<小文字の id>` で 1 回探す（ファストパス）→ 無ければ項目ごとに `metafields.<namespace>.<key>:*` で全件を見る。見つけた人にはタグを付ける。
- 全件を見るのは、絞り込みが効く項目だけ（`app/lib/memberCardFieldFilter.server.ts`）。Shopify は、定義が無い・定義の絞り込み（`capabilities.adminFilterable`）がオフのメタフィールドで絞ると、2026-07 までの API では条件を黙って無視してすべての顧客を返し、2026-10 からはエラーを返す（Shopify changelog「Invalid metafield queries now return errors in the GraphQL Admin API」）。そのため `socialplus.line` 以外の項目は、先に `metafieldDefinitions(ownerType: CUSTOMER, namespace, key)` を読み、定義があって `adminFilterable.enabled = true` かつ `status = FILTERABLE` のときだけ全件を見る（店ごと・項目ごとに 5 分覚える。読めなかったときは覚えない）。定義がオンでも、値の空の顧客が返ってきたら絞り込みが効いていないと見て、その項目は打ち切る（5 分見ない）。
- 定義が無い・定義の絞り込みがオフの項目は「確かめた。この項目は見ない」として次の項目へ進む（エラーではない）。今の本番（`line_crm.line_user_id` の定義が無い）は、この形で main と同じ答えになる。
- その項目を見られなかったとき（定義を読めない・検索のエラー）は、**後の項目へ進まずに `API_ERROR` を返す**（タグも付けない）。後の項目で見つけた人を返すと、同じ LINE ID が 2 人に付いているとき（例: C1 は `line_crm.line_user_id`、C9 は `socialplus.line` だけ）に先の項目にいる本人（C1）ではなく別の人（C9）を返し、タグ `line:` を付けてファストパスで返し続けるため（PR #36 のレビューの P2-1）。検索のエラーは、本文の `errors` で返っても、client が投げても同じに扱う（`@shopify/shopify-api` の client は、GraphQL の `errors` があると `GraphqlQueryError` を投げ、5xx・通信の切断でも投げる）。
- Throttled は、検索も定義の読み込みも `adminGraphqlWithRetry`（`app/lib/shopifyGraphqlThrottle.server.ts`）で待ってやり直す（2s → 4s → 8s → 16s、5 回まで）。一時の Throttled は「見られなかった」にならない。使い切ったら次の項目へ進まずに `THROTTLED` を返す。
- 未確認: 同じ LINE ID が 2 人に付くことが実際にあるか（LINE CRM が連携するときに重複を防ぐか）。main の時代に `socialplus.line` で見つけた人にはもうタグが付いているので、2 人いる店では正常なときでもファストパスで後の人が返る。ありうるなら、ファストパスも含めて別に考える。
- `socialplus.line` は前と同じ動き（定義を確かめずに `metafields.socialplus.line:*` で全件を見る。その検索がエラーで、ほかの項目でも見つからなければ `API_ERROR`。既定の順では最後なので main と同じ答え）。
- 未確認: 開発ストアで `line_crm.line_user_id` の定義の絞り込みがオン／オフのときに、全件の検索が何件返すか（オフなら全顧客が返り、上の打ち切りが働くはず）。定義の絞り込みは LINE CRM が定義を作るときにオンにする（line-crm 側の PR）。

## 7. Printing（現行: Conditional-Go）

基準: `c69438d` 以降。POS UI Extensions `api_version = "2026-07"` + `extensions/common/printApi.js`（`shopify.printing.getPrinters` / `print`）。

### 7.1 現状フロー

```
注文作成（Shopify 標準）
  │
  ├─ 販売レシート: HTML `/api/print/sales/:id` → shopify.printing（SalesReceiptModal）
  │
  ├─ 領収書: DB 発行 +（設定 ON 時）HTML `/api/print/receipt/:id` → shopify.printing
  │
  └─ 精算:
       ├─ Printing API（preferPrintingApi 等）: HTML `/api/print/settlement/:id` → shopify.printing
       ├─ order_based → SETTLEMENT 注文 → 人が POS 標準レシート印字（旧経路・残置）
       └─ cloudprnt_direct → テキスト payload 提供（ポーリング想定・送信アダプタなし・Advanced）
```

**方針（監査既定 / P0）**: Printing を主経路にする店舗では印字用途の SETTLEMENT 作成を抑制しうる（アーカイブ明示オプトインのみ作成）。旧経路の完全削除は mPOP 実機 Go 後。

### 7.2 ギフトレシート

- Shopify Gift Receipt 連携は **未実装**
- 本アプリの「レシート」は精算・領収書・販売レシート HTML を指す

### 7.3 旧経路との関係

| 経路 | 状態 |
|------|------|
| `shopify.printing` + HTML エンドポイント | **現行の推奨／追加経路**（Conditional-Go） |
| `order_based` SETTLEMENT 注文 | **残置**。Printing 優先時は作成スキップ方針（P0） |
| `cloudprnt_direct` | **Advanced／レガシー**。廃止候補。紙幅は中立 `paperWidthMm`（レガシー `cloudprntPaperWidth` と同期） |

集計エンジン・特殊返金 DB・metafield・返金帰属は印字経路と分離（移行しても触らない核）。

## 8. POS Extension ターゲット

| handle | targets |
|--------|---------|
| `pos-special-refund` | home.tile, home.modal, order-details.action |
| `pos-voucher-adjustment` | 同上 |
| `pos-settlement` | home.tile, home.modal |
| `pos-receipt-issue` | home.tile, home.modal, order-details.action |
| `pos-sales-summary` | home.tile, home.modal |

## 9. 関連既存 docs

- `docs/GRAPHQL_OFFICIAL_COMPLIANCE.md`
- `docs/ERROR_ORDER_ACCESS_PROTECTED_DATA.md`
- `docs/SETUP_POS_APP.md`
- `docs/POS_LOCATION_SCOPE.md`

## 10. 未確認

- mPOP 実機での Printing 直印字品質（紙幅・日本語・切断）。旧経路削除の前提
- 各ストアで有効なカスタム決済の gateway 実文字列の完全一覧（マスタで吸収する設計）
- Webhook 再送時の売上サマリーキューの完全な idempotency 保証範囲
