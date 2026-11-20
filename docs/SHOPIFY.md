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
| Admin SDK（`app/shopify.server.ts`） | `ApiVersion.October25` |
| Webhooks（`shopify.app.toml`） | `api_version = "2026-04"` |
| POS Extension | `api_version = "2026-01"` |

意図的差分の公式根拠は **未確認**。実装時は各エントリポイントの宣言を正とする。

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
| staffMember on lineItems | 注文詳細表示のみ |
| customAttributes | 取得のみ（精算・領収書 UI では未使用） |
| DraftOrder → Order（SETTLEMENT / INSPECTION） | order_based 印字用 |
| Fulfillment create（V2→フォールバック） | 精算注文クローズ |
| Gift Cards API（任意） | レガシー発行額加算 |
| Location | 同期・表示・printMode |
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
| `special_refund_events` | 定義あり（JSON） |
| `voucher_change_events` | 定義あり（JSON） |
| `business_adjustments_version` | バージョン |

定義 ensure: OAuth / `POST /api/admin/settlement-metafields/ensure`

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
