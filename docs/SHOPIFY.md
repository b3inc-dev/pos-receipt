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
| compliance（customers/data_request, customers/redact, shop/redact） | `/webhooks/compliance` | GDPR。`data_request` は DB 列挙＋根拠ログ後に 200（email/phone 非保存。開示は運用）。詳細は `gdprCustomerDataRequest.server.ts`。`shop/redact` は使用量の記録 `AppUsageReport`・セッション・Shop（CASCADE）を消し、件数だけを記録に出す（`shopRedact.server.ts`） |
| `orders/updated` | `/webhooks/orders/updated` | 売上サマリー更新キュー + 返金計上 metafield 同期。キューに置いた中身は 30 日で消す（スイッチ `ORDER_WEBHOOK_QUEUE_PURGE`・既定オフ。DECISIONS D17） |

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
