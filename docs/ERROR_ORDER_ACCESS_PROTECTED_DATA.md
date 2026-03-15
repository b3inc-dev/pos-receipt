# 「This app is not approved to access the Order object」(HTTP 500) の対処

領収書の「取引を選択」や注文検索で、注文（Order）にアクセスした際にこのメッセージが出る場合の対処です。

## 公式情報

- [Protected customer data（保護された顧客データ）](https://shopify.dev/docs/apps/launch/protected-customer-data)  
  Order は顧客に関連する保護データに含まれるため、アプリが Order にアクセスするには **アクセス承認** が必要な場合があります。

## やること

1. **スコープの確認**  
   `shopify.app.toml` の `[access_scopes]` に **`read_orders`** が含まれているか確認してください。含まれている場合でも、ストア側でアプリを再インストールし直し、スコープを再度許可してもらうと解消することがあります。

2. **Partner Dashboard で Order アクセスを許可**  
   - [Partner Dashboard](https://partners.shopify.com) → 対象アプリ → **設定**  
   - **Protected customer data** で、Order（注文）へのアクセスが必要である理由を記載し、**Request access** を申請する。  
   - 開発ストアのみで使うアプリの場合は、申請後すぐに開発ストアではアクセスできる場合があります。

3. **アプリの再インストール**  
   ストアで一度アプリをアンインストールし、再度インストールしてスコープ（`read_orders` 等）を改めて許可してもらう。

## 参照の仕方が公式かどうか

- 注文の取得は **GraphQL Admin API** の [Order](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order) および [orders クエリ](https://shopify.dev/docs/api/admin-graphql/latest/queries/orders) を使用しており、公式の型・フィールドに沿っています。
- 領収書・精算で必要な範囲（`id`, `name`, `totalPriceSet`, `customer`, `retailLocation`, `lineItems`, `transactions`, `refunds` など）は、いずれも Admin API の Order オブジェクトの公式フィールドです。

エラーが「権限・承認」に関するメッセージの場合は、上記の承認フローと再インストールを試してください。
