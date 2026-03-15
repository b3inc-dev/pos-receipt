# GraphQL Admin API 公式準拠一覧

POS Receipt アプリ内の GraphQL クエリ・ミューテーションが、Shopify Admin API の公式仕様に沿っていることをまとめたドキュメントです。

## 参照元（公式）

- [Shopify Admin API - GraphQL](https://shopify.dev/docs/api/admin-graphql)
- [Order](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order)
- [OrderTransactionConnection](https://shopify.dev/docs/api/admin-graphql/latest/connections/OrderTransactionConnection)
- [Refund](https://shopify.dev/docs/api/admin-graphql/latest/objects/Refund)
- [LineItemConnection](https://shopify.dev/docs/api/admin-graphql/latest/connections/LineItemConnection)
- [LocationConnection](https://shopify.dev/docs/api/admin-graphql/latest/connections/LocationConnection)
- [CustomerConnection](https://shopify.dev/docs/api/admin-graphql/latest/connections/CustomerConnection)

---

## 1. Connection 型の取得方法

Admin API の Connection 型は **`edges { node { ... } }`** と **`nodes { ... }`** の両方をサポートしています。  
本アプリでは公式で推奨される **`nodes`** に統一し、ページングは **`pageInfo { hasNextPage endCursor }`** で行います。

| 対象 | 型 | 本アプリでの取得方法 |
|------|-----|----------------------|
| `orders` クエリ | OrderConnection | `nodes { ... }` + `pageInfo` |
| `Order.lineItems` | LineItemConnection | `nodes { quantity }` など |
| `Order.refunds` | リスト [[Refund!]!] | 直接 `refunds { id ... }`（first あり） |
| `Order.transactions` | リスト [[OrderTransaction!]!] | 直接 `transactions(first: 50) { id kind ... }` |
| `Refund.transactions` | OrderTransactionConnection | `nodes { id kind ... }` |
| `locations` クエリ | LocationConnection | `nodes { id name isActive }` |
| `customers` クエリ | CustomerConnection | `nodes { ... }` + `pageInfo` |

---

## 2. Order まわり（公式仕様との対応）

- **Order.transactions**  
  - 型: `[[OrderTransaction!]!]`（リスト）。Connection ではないため **`edges` は存在しない**。  
  - クエリ例: `transactions(first: 50) { id kind status amountSet { shopMoney { amount currencyCode } } gateway }`
- **Order.refunds**  
  - 型: `[[Refund!]!]`（リスト）。`refunds { id createdAt ... }` で取得。
- **Order.lineItems**  
  - 型: `LineItemConnection!`。`lineItems(first: 250) { nodes { quantity } }` で取得。
- **Order.retailLocation**  
  - 型: `Location`。ロケーションは **`location` ではなく `retailLocation`** を使用（`location` は Order に存在しない）。

---

## 3. 修正済みファイル一覧（nodes 統一）

| ファイル | 変更内容 |
|----------|----------|
| `app/services/settlementEngine.server.ts` | orders: nodes / lineItems: nodes / Refund.transactions: nodes |
| `app/services/salesSummaryEngine.server.ts` | orders: nodes / lineItems: nodes |
| `app/routes/api.orders.search.tsx` | orders: nodes |
| `app/routes/api.locations.tsx` | locations: nodes |
| `app/routes/app.settings.tsx` | locations: nodes |
| `app/routes/app.sales-summary-settings.tsx` | locations: nodes（loader / action） |
| `app/routes/app.budget-management.tsx` | locations: nodes |
| `app/lib/customer.server.ts` | customers: nodes |

---

## 4. その他のクエリ・ミューテーション

- **shop**  
  - `shop { id }` / `shop { ianaTimezone }` / `shop { plan { partnerDevelopment } }` … いずれも [Shop](https://shopify.dev/docs/api/admin-graphql/latest/objects/Shop) の公式フィールド。
- **order (単体)**  
  - `order(id: $id) { id name ... retailLocation { id name } ... }` … [Order](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order) の公式フィールド。
- **draftOrderCreate / draftOrderComplete**  
  - [draftOrderCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderCreate) / [draftOrderComplete](https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderComplete) の入力・戻り値に準拠。
- **tagsAdd**  
  - [tagsAdd](https://shopify.dev/docs/api/admin-graphql/latest/mutations/tagsAdd) の `id`, `tags`, `node`, `userErrors` に準拠。
- **currentAppInstallation**  
  - サブスクリプション取得で使用。公式の `currentAppInstallation { activeSubscriptions { ... } }` に準拠。

---

## 5. エラー解消の参照

- 精算時の「Field 'edges' doesn't exist on type 'OrderTransaction'」→ `docs/ORDER_TRANSACTION_CONNECTION_500_DEBUG.md`
- 領収書の「Order にアクセスできません」→ `docs/ERROR_ORDER_ACCESS_PROTECTED_DATA.md`
