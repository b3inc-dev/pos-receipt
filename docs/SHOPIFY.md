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
| compliance（customers/data_request, customers/redact, shop/redact） | `/webhooks/compliance` | GDPR |
| `orders/updated` | `/webhooks/orders/updated` | 売上サマリー更新キュー + 返金計上 metafield 同期 |

## 6. メタフィールド

### 6.1 namespace `settlement`（精算注文）

定義: `settlementMetafieldDefinitions.server.ts`  
主な key: `period_label`, `location_label`, `as_of`, `version`, `total`, `refund_total`, `discounts`, `vip_points_used`, `tax`, `net_sales`, `tax_shopify`, `voucher_change`, `order_count`, `refund_count`, `item_count`, `payment_sections`  
追加書込: `settlement.uniq`, `settlement.copy_type`（inspection）

### 6.2 namespace `pos`（業務注文）

| key | 用途 |
|-----|------|
| `refund_aggregation_location_gid` | 返金の精算計上先 |
| `special_refund_events` | 定義あり（JSON） |
| `voucher_change_events` | 定義あり（JSON） |
| `business_adjustments_version` | バージョン |

定義 ensure: OAuth / `POST /api/admin/settlement-metafields/ensure`

## 7. Printing（現状と移行候補の分離）

### 7.1 現状フロー

```
注文作成（Shopify 標準）
  │
  ├─ 領収書: アプリ DB 発行のみ（Printing API 不使用）
  │
  └─ 精算:
       order_based → SETTLEMENT 注文を作り、人間が POS 標準レシート印字
       cloudprnt_direct → アプリがテキスト payload を提供。プリンタ側ポーリング想定
```

**Shopify Printing API / printJob / device.print 等の呼び出しはリポジトリに存在しない。**

### 7.2 ギフトレシート

- 要件・コードともに Shopify Gift Receipt 連携は **未実装**
- 本アプリの「レシート」は精算レシートと領収書を指す

### 7.3 Printing API 等へ移行できそうな部分（調査のみ・実装しない）

| 現状 | 移行検討候補（アイデアレベル） | 制約・未確認 |
|------|--------------------------------|--------------|
| order_based で SETTLEMENT 注文を作り POS 標準印字 | Printing API で精算レイアウトを直接印字できれば、精算注文作成を省略できる可能性 | Printing API の POS 対応範囲・店舗プリンタ要件は未確認 |
| cloudprnt_direct のテキスト payload | 同じペイロード生成を維持したまま送信経路だけ Printing API / 他プロトコルに差し替える可能性 | 現行はポーリング URL 提供のみ。送信アダプタなし |
| 領収書の画面表示のみ | Printing API または CloudPRNT への出力を追加する余地 | `receiptPrintMode` 設定はあるが issue 経路で未使用 |
| 点検レシート | 精算と同レイアウト経路を共有しているため、印字経路変更の影響を精算と同時に受ける | DoneView 文言と order_based 同期の不一致あり（DECISIONS） |

**移行しない／分離して残る可能性が高い部分**

- 集計エンジン・特殊返金 DB・冪等キー・メタフィールドへの数値保存
- PaymentMethodMaster と GAS 正規化ロジック
- 返金計上ロケーション解決

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

- Printing API の店舗導入前提（ハードウェア・POS バージョン）
- 各ストアで有効なカスタム決済の gateway 実文字列の完全一覧（マスタで吸収する設計）
- Webhook 再送時の売上サマリーキューの完全な idempotency 保証範囲
