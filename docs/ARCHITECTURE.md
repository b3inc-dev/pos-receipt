# ARCHITECTURE — 構成とデータフロー

コードで確認した現行アーキテクチャです。推測は「未確認」とします。

## 1. ランタイム構成

| 層 | 技術 | 備考 |
|----|------|------|
| Backend | Node 20+, Express (`server.js`) + React Router 7 | `npm run start` |
| Admin UI | Polaris + embedded app (`app/routes/app.*`) | |
| API | `app/routes/api.*` | POS はセッショントークン認証（`posAuth.server`） |
| DB | PostgreSQL + Prisma | `prisma/schema.prisma` |
| POS Extension | UI Extension `api_version = "2026-01"` | `extensions/pos-smart-grid` |
| Shopify Admin API | `ApiVersion.October25`（`app/shopify.server.ts`） | Webhook TOML は `2026-04` |
| ジョブ | pg-boss | `orders/updated` 経由の売上サマリー更新キュー |

## 2. コンポーネント境界

### 2.1 Backend（Render）

- 精算プレビュー／作成、領収書、特殊返金、売上サマリー、設定 CRUD
- Shopify Admin GraphQL（注文検索、下書き完了、メタフィールド、履行）
- Prisma への永続化

### 2.2 POS Extension

- ホームタイル: 精算、領収書、特殊返金、商品券、売上サマリー
- 取引詳細メニュー: 領収書発行、特殊返金、商品券
- Backend URL はビルド時 `extensions/common/appUrl.js` の `APP_MODE`（public / inhouse）

### 2.3 Admin 埋め込み

- ロケーション／支払方法／精算・印字・領収書テンプレ／特殊返金／売上サマリー／プラン等の設定画面

### 2.4 GAS

- リポジトリ内に実行コードなし。ロジック移植の参照元（コメント・docs）

## 3. エンドツーエンドデータフロー（注文 → 精算レシート）

```
A. 店舗で販売／返金（Shopify POS または Admin）
      │  元データ: Shopify Order / Transaction / Refund
      │  保存先: Shopify
      ▼
B. （任意）orders/updated Webhook
      │  加工: 売上サマリー日次キャッシュ更新キュー
      │       + 返金計上ロケーション metafield 同期（pos.refund_aggregation_location_gid）
      │  保存先: SalesSummaryCache* / Order metafield
      ▼
C. POS「精算」→ GET/POST preview（buildSettlementPreview）
      │  取得: location_id × 当日 created∪updated∪cancelled（tag_not:settlement）
      │  加工: トランザクション日次集計・現金キャップ・VIP/割引按分・特殊返金反映
      │  保存: なし（プレビュー）。必要に応じ日次キャッシュ upsert
      │  表示: SettlementModal プレビュー
      ▼
D. POST /api/settlements/create
      │  printMode = Location.printMode（body の printMode は決定に使わない）
      │  冪等: shopId:locationId:targetDate:printMode（点検除く）
      │  ロック: SettlementOperationLock
      ├─ order_based → Draft 精算/点検注文 → complete → note/metafields → fulfill
      │                 Settlement 行に sourceOrderId 等を保存
      └─ cloudprnt_direct → Settlement 保存 + printPayload テキスト（Shopify 精算注文なし）
      ▼
E. 印字
      ├─ order_based: スタッフが POS 上で精算注文のレシートを印字（アプリはプリンタ API 未使用）
      └─ cloudprnt_direct: プリンタが GET .../print-payload をポーリング（想定）。アプリ内に CloudPRNT 送信アダプタなし
      ▼
F. POST /api/settlements/print → status=printed（DB マークのみ）
```

### 各段階の整理

| 段階 | 元データ | 加工 | 保存先 | 表示／出力先 |
|------|----------|------|--------|--------------|
| 販売注文 | POS/Admin 操作 | Shopify 標準 | Shopify Order | POS / Admin |
| 返金計上先 | Order + refund TX location + 設定 | `resolveRefundAggregationLocationGid` | `pos.refund_aggregation_location_gid` | 精算集計時に参照 |
| 精算プレビュー | Orders + SpecialRefundEvent +（任意）Gift Cards API | `aggregateGasStyleForOrders` 等 | なし／サマリーキャッシュ | POS 精算 UI |
| 精算確定 | プレビュー DTO | 永続化＋（任意）Shopify 同期 | `Settlement` / Shopify SETTLEMENT 注文 | Done 画面 |
| 精算印字 | Settlement / 精算注文 | テキスト生成 or 人的 POS 印字 | `printedAt` | プリンタ／POS |
| 領収書 | Order totalPriceSet | テンプレ合成 | `ReceiptIssue` | POS 完了画面（印字 API なし） |

## 4. 領収書フロー（ギフトレシートではない）

```
注文選択（検索 or 取引詳細）
  → preview（テンプレ + 宛名/但し書き + 金額）
  → issue（ReceiptIssue + idempotencyKey）
  → 履歴表示
```

- Shopify Gift Receipt / Printing API への接続は **コード上なし**。
- `receiptPrintMode` 設定キーは存在するが、issue/preview ルートでは未使用。

## 5. 特殊返金フロー（要約）

```
注文検索（location 指定時は source_name:pos + retailLocation フィルタ）
  → イベント種選択 → SpecialRefundEvent 保存
  →（種別に応じ）Shopify 返金実行 shopifyRefundExecute
  → 精算プレビュー時に paymentSections / totals へ反映（設定フラグ依存）
```

## 6. モジュール配置

```
app/services/settlementEngine.server.ts     … 集計の中核
app/services/settlementOrderGas.server.ts   … SETTLEMENT/INSPECTION 注文
app/services/settlementSyncSettings.server.ts … printMode × 設定で同期可否
app/services/settlementLock.server.ts       … 同時作成ロック
app/services/refundAggregation.server.ts   … 返金ロケーション解決
app/services/salesSummaryEngine.server.ts  … buildSettlementPreview 再利用
app/services/salesChannelEngine.server.ts  … 非 POS チャネル集計
app/routes/api.settlements.*               … 精算 API
app/routes/api.receipts.*                  … 領収書 API
app/routes/api.special-refunds.*           … 特殊返金 API
app/routes/webhooks.orders.updated.tsx     … キャッシュ・metafield
```

## 7. デプロイ

| 経路 | 内容 |
|------|------|
| Shopify 拡張・アプリ設定 | `npm run deploy:public` / `deploy:inhouse`（APP_MODE 切替 + `shopify app deploy`） |
| Backend | Render Build: `npm install && prisma generate && npm run build` / Pre-Deploy: migrate / Start: `npm run start` |
| DB | Prisma migrate（`scripts/render-migrate.mjs` 等） |
| GitHub → Render | docs 上は Auto-Deploy 言及あり。リポジトリ内 workflow はなし |

詳細: `docs/DEPLOY_PUBLIC_AND_INHOUSE.md`, `docs/RENDER_SETUP.md`

## 8. 認証

| クライアント | 方式 |
|--------------|------|
| Admin `/app/*` | Shopify embedded session |
| POS `/api/*` | POS session token → `authenticatePosRequestOrCorsError` |
| 公開売上サマリー | トークン URL + 任意パスワード（Shop カラム） |

## 9. 未確認

- CloudPRNT 実機が payload URL をどう認証するか（アプリ側のプリンタ認証実装は見当たらない）
- Render 以外の本番ホストの有無
- Admin API バージョン（October25）と webhook TOML（2026-04）の運用上の意図的差分の公式根拠

## 開発時の検証境界

Backend/AdminのReact Router buildとPOS拡張のbuild/実機は別gate。testsは実コードのpure関数（精算text・注文表示データ・日付境界）を限定評価し、Prisma/Shopify importの副作用を回避する。API/集計全体/UI/実印字の統合テストを代替しない。[DEVELOPMENT_TESTING.md](DEVELOPMENT_TESTING.md)を参照。

Render経路は共通workflowの2026-10-04監査でpublic/inhouse両方main/On Commitと確認済み。上記の古い「docs上の言及」は監査前の記述。本番反映は明示承認まで停止し、Shopify設定/拡張releaseと分離する。
