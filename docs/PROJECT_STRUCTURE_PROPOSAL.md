# POS Receipt プロジェクト構成案

本ドキュメントは `posreceipt_requirements_spec.md` を元に、技術スタック前提で **Admin App / POS Extensions / Backend API / DB / Jobs** のディレクトリ構成と責務分離を提案するものです。

---

## 1. 技術スタック前提

| 領域 | 技術 |
|------|------|
| Admin App | React Router v7（Shopify App）、Polaris、TypeScript |
| POS Extensions | Shopify POS UI Extension（Preact / React）、JavaScript |
| Backend API | 同一 Node サーバー内のルート（React Router の `app/routes/api.*`） |
| DB | Prisma + SQLite（開発）/ PostgreSQL（本番・Render + Supabase 想定） |
| Jobs | Render Cron または HTTP エンドポイント経由のバッチ（`app/routes/api.jobs.*`） |
| デプロイ | Render（公開用・自社用で別サービス or 同一サービスで環境変数切り替え） |

---

## 2. ルートディレクトリ構成

```
pos-receipt/
├── app/                    # Admin App + Backend API（同一サーバー）
│   ├── routes/             # 画面ルート + API ルート
│   ├── components/         # Admin 用 React コンポーネント
│   ├── utils/              # 共通ユーティリティ・ヘルパー
│   ├── services/           # ビジネスロジック（精算・領収書・サマリー等）
│   ├── lib/                # DB アクセス・Shopify API ラップ等
│   └── shopify.server.ts   # Shopify アプリ設定
├── extensions/             # POS UI Extensions
│   ├── common/             # 全拡張で共有（appUrl, 共通 API 呼び出し）
│   ├── pos-receipt-settlement/   # 精算タイル
│   ├── pos-receipt-refund/      # 特殊返金・商品券調整タイル
│   ├── pos-receipt-receipt/     # 領収書タイル
│   └── pos-receipt-summary/     # 売上サマリータイル
├── prisma/
│   ├── schema.prisma       # データモデル定義
│   └── migrations/        # マイグレーション
├── scripts/                # デプロイ・モード切替・手動ジョブ用
├── docs/                   # 要件書・設計・運用ドキュメント
├── shopify.app.toml        # 自社用アプリ設定
├── shopify.app.public.toml # 公開用アプリ設定
└── package.json
```

---

## 3. Admin App（`app/`）の責務と構成

**責務**: ショップオーナー・本部向けの管理画面。設定の編集、履歴の閲覧、予算・テンプレート管理。

### 3.1 ディレクトリ構成

```
app/
├── routes/
│   ├── app.tsx                 # Admin レイアウト・認証
│   ├── app._index.tsx          # ダッシュボード / ホーム
│   ├── app.settings.tsx        # 一般設定（印字方式・機能フラグ・入店数報告 ON/OFF）
│   ├── app.settings.receipt.tsx    # 領収書テンプレート編集・プレビュー
│   ├── app.settings.sales-summary.tsx  # 売上サマリー設定・対象店舗
│   ├── app.budgets.tsx         # 予算一覧・手動編集・CSV インポート
│   ├── app.settlements.tsx     # 精算履歴一覧・再印字導線
│   ├── app.settlements.$id.tsx # 精算詳細（任意）
│   ├── app.receipts.tsx        # 領収書発行履歴
│   ├── app.special-refunds.tsx # 特殊返金・商品券調整イベント一覧
│   └── app.plan.tsx            # プラン表示（スタンダード/プロ）
├── components/                 # Admin 専用 UI パーツ（必要に応じて）
├── utils/
│   ├── plan.ts                # プラン判定（APP_DISTRIBUTION=inhouse 時は全機能）
│   ├── feature-flags.ts       # 機能フラグ
│   └── schemas.ts             # Zod 等バリデーション
├── services/                   # ドメインロジック（後述）
├── lib/
│   ├── db.ts                  # Prisma クライアント
│   ├── shopify-api.ts         # Admin API / Storefront 等ラップ
│   └── session.ts             # セッション・shop 解決
└── shopify.server.ts
```

### 3.2 責務まとめ

- **画面**: 設定・履歴・予算の表示・編集。
- **認証**: Shopify セッションから `shop` を解決し、API と共有。
- **プラン制御**: `APP_DISTRIBUTION=inhouse` のときは全機能、それ以外は Billing API でスタンダード/プロを判定し、売上サマリー等の表示・API を制御。

---

## 4. Backend API（`app/routes/api.*`）の責務と構成

**責務**: POS 拡張・Admin 画面の両方から呼ばれる API。注文検索、精算・領収書・特殊返金・売上サマリー・設定の読み書き。同一 Node サーバーで動かす。

### 4.1 API ルート一覧（要件書 21 章に対応）

```
app/routes/
├── api.orders.search.tsx      # GET /api/orders/search
├── api.orders.$orderId.tsx    # GET /api/orders/:orderId
├── api.settlements.preview.tsx   # POST /api/settlements/preview
├── api.settlements.create.tsx   # POST /api/settlements/create
├── api.settlements.recalculate.tsx
├── api.settlements.print.tsx
├── api.special-refunds.tsx    # POST/GET /api/special-refunds
├── api.special-refunds.$id.void.tsx  # POST /api/special-refunds/:id/void
├── api.voucher-adjustments.tsx # POST /api/voucher-adjustments
├── api.receipts.preview.tsx   # POST /api/receipts/preview
├── api.receipts.issue.tsx     # POST /api/receipts/issue
├── api.receipts.history.tsx   # GET /api/receipts/history
├── api.sales-summary.daily.tsx   # GET /api/sales-summary/daily
├── api.sales-summary.period.tsx  # GET /api/sales-summary/period
├── api.footfall.tsx           # POST /api/footfall
├── api.budgets.import.tsx     # POST /api/budgets/import
├── api.budgets.upsert.tsx     # POST /api/budgets/upsert
├── api.settings.tsx           # GET/POST /api/settings
│
├── api.jobs.sales-cache-refresh.tsx   # 日次キャッシュ更新（5分ごと等）
├── api.jobs.daily-archive.tsx        # 前日確定・アーカイブ
├── api.jobs.monthly-cache.tsx        # 月次キャッシュ更新
└── api.jobs.rebuild-cache.tsx        # 期間指定キャッシュ再構築（任意）
```

認証は共通ミドルウェアまたは `app/utils/session.ts` で行い、`shop` をコンテキストに載せる想定。

### 4.2 責務まとめ

- **注文検索**: Shopify Admin API で注文を検索し、取引選択 UI 用の一覧・詳細を返す。
- **精算**: 集計・保存・印字（CloudPRNT 直印字 / 精算注文経由）の分岐はサービス層で実施。
- **特殊返金・商品券**: イベントの作成・一覧・無効化（void）。
- **領収書**: プレビュー・発行・履歴。テンプレートは DB から取得。
- **売上サマリー**: 日次/期間のキャッシュ読み取り、入店数・予算の更新。キャッシュ更新は Jobs に任せる。
- **設定**: ロケーション別印字方式・入店数報告 ON/OFF・領収書テンプレート等の読み書き。

---

## 5. サービス層（`app/services/`）の責務

API ルートは薄く保ち、ビジネスロジックは `app/services/` に集約する。

```
app/services/
├── orders/              # 注文検索
│   └── order-search.server.ts
├── settlement/          # 精算エンジン
│   ├── settlement-engine.server.ts
│   ├── settlement-preview.server.ts
│   └── settlement-print.server.ts
├── special-refund/      # 特殊返金・商品券調整
│   └── special-refund-events.server.ts
├── receipt/             # 領収書
│   ├── receipt-preview.server.ts
│   ├── receipt-issue.server.ts
│   └── receipt-template.server.ts
├── sales-summary/       # 売上サマリー・キャッシュ
│   ├── sales-summary-cache.server.ts
│   ├── footfall.server.ts
│   └── budget.server.ts
└── print/               # 印字アダプター（要件 13 章）
    ├── print-adapter.interface.ts
    ├── cloudprnt-adapter.server.ts
    └── order-based-adapter.server.ts
```

- **Settlement Engine**: 対象日・ロケーションで Shopify 売上を集計し、特殊返金・商品券調整イベントを反映して精算データを生成。
- **Print Adapter**: CloudPRNT 直印字と「精算注文経由」の 2 方式をインターフェースで抽象化し、ロケーション設定で切り替え。

---

## 6. POS Extensions（`extensions/`）の責務と構成

**責務**: POS タイル・モーダル UI と、Backend API の呼び出し。4 タイル + 共通モジュール。

### 6.1 ディレクトリ構成

```
extensions/
├── common/
│   ├── appUrl.js              # APP_MODE に応じたベース URL（公開用/自社用）
│   ├── api.js                 # 共通 fetch ラップ（認証ヘッダー等）
│   └── order-picker.js        # 取引検索一覧の共通ロジック（再利用）
│
├── pos-receipt-settlement/    # タイル: 精算
│   ├── shopify.extension.toml
│   ├── src/
│   │   ├── Tile.jsx
│   │   ├── Modal.jsx
│   │   ├── settlementApi.js
│   │   └── screens/
│   │       ├── SettlementScreen.jsx    # 今日/指定日・プレビュー・実行・点検
│   │       └── ...
│   └── locales/
│
├── pos-receipt-refund/        # タイル: 特殊返金・商品券調整
│   ├── shopify.extension.toml
│   ├── src/
│   │   ├── Tile.jsx
│   │   ├── Modal.jsx
│   │   ├── refundApi.js
│   │   └── screens/
│   │       ├── OrderListScreen.jsx     # 取引検索（common/order-picker 利用可）
│   │       ├── RefundFormScreen.jsx
│   │       ├── VoucherAdjustScreen.jsx
│   │       └── ...
│   └── locales/
│
├── pos-receipt-receipt/       # タイル: 領収書
│   ├── shopify.extension.toml
│   ├── src/
│   │   ├── Tile.jsx
│   │   ├── Modal.jsx
│   │   ├── receiptApi.js
│   │   └── screens/
│   │       ├── OrderListScreen.jsx
│   │       ├── ReceiptFormScreen.jsx
│   │       ├── ReceiptPreviewScreen.jsx
│   │       └── ...
│   └── locales/
│
└── pos-receipt-summary/       # タイル: 売上サマリー（プロプラン）
    ├── shopify.extension.toml
    ├── src/
    │   ├── Tile.jsx
    │   ├── Modal.jsx
    │   ├── summaryApi.js
    │   └── screens/
    │       ├── SummaryScreen.jsx       # 日付/期間・ロケーション別表示
    │       ├── FootfallForm.jsx        # 入店数報告（設定 ON 時のみ）
    │   └── ...
    └── locales/
```

### 6.2 共通モジュール（`common/`）

- **appUrl.js**: 要件 0.1.2 の通り。`APP_MODE = "public" | "inhouse"` でベース URL を切り替え、`getAppUrl()` を提供。各拡張はここを参照して API を呼ぶ。
- **order-picker**: 取引検索・一覧・選択の共通 UI/ロジック。特殊返金・領収書で再利用し、取引詳細画面から「現在の取引」で起動する導線もここで扱う。

### 6.3 責務まとめ

| 拡張 | 責務 |
|------|------|
| pos-receipt-settlement | 精算対象日選択、プレビュー表示、精算/点検レシート実行、再印字。印字方式は Backend が判定。 |
| pos-receipt-refund | 取引検索 → 特殊返金 or 商品券調整の選択 → 入力・送信。同一取引のイベント一覧表示。 |
| pos-receipt-receipt | 取引検索 → 宛名・但し書き入力 → プレビュー → 発行/再発行。 |
| pos-receipt-summary | 日付/期間指定でサマリー表示。設定 ON 時のみ入店数報告 UI を表示。 |

---

## 7. DB（`prisma/`）の責務と構成

**責務**: アプリ正本データの永続化。Shopify は注文・返金・ロケーション等の正本、アプリ DB は精算・特殊返金イベント・領収書・入店数・予算・キャッシュの正本（要件 4.2）。

### 7.1 ディレクトリ構成

```
prisma/
├── schema.prisma    # 全モデル定義（要件 20 章）
└── migrations/      # マイグレーション履歴
```

### 7.2 モデル（要件書 20 章に対応）

- **shops** / **locations** / **app_settings**: ショップ・ロケーション・キー値設定。
- **settlements**: 精算実行履歴。
- **special_refund_events**: 特殊返金・商品券調整イベント。
- **receipt_templates** / **receipt_issues**: 領収書テンプレート（1 本）・発行履歴。
- **budgets** / **footfall_reports**: 予算・入店数。
- **sales_summary_cache_daily** / **sales_summary_cache_period**: 売上サマリー用キャッシュ。

Session は Shopify アプリ用に Prisma アダプターで保存する想定。

### 7.3 責務まとめ

- 正本はアプリ DB。Shopify メタフィールドは表示互換・監査補助のみ（要件 4.3）。
- キャッシュテーブルは Jobs が更新し、API は読み取り専用で返す設計とする。

---

## 8. Jobs の責務と構成

**責務**: 売上サマリーのキャッシュ更新・前日確定・月次集計。要件 25 章のバッチを HTTP エンドポイントで実行し、Render Cron 等から呼ぶ。

### 8.1 実装パターン

- **同一アプリ内に API ルートを用意**: `app/routes/api.jobs.*.tsx`。
- Render Cron で「5 分ごと」「毎日 0 時」等に該当 URL を GET/POST。認証は Cron 専用のシークレットヘッダーやトークンで保護。

### 8.2 ジョブ一覧（要件 25 章対応）

| ジョブ | ルート例 | 頻度 | 責務 |
|--------|----------|------|------|
| Daily Sales Cache Refresh | `api.jobs.sales-cache-refresh.tsx` | 5 分ごと（営業時間帯） | 当日分の `sales_summary_cache_daily` 更新 |
| Daily Archive | `api.jobs.daily-archive.tsx` | 毎日深夜 | 前日分を確定値として保存 |
| Monthly Cache | `api.jobs.monthly-cache.tsx` | 毎日深夜 | 月次進捗キャッシュ更新 |
| Optional Rebuild | `api.jobs.rebuild-cache.tsx` | 手動 or 任意スケジュール | 期間指定でキャッシュ再構築 |

### 8.3 スクリプト（`scripts/`）

- **set-app-mode.js**: `extensions/common/appUrl.js` の `APP_MODE` を `public` / `inhouse` に書き換え（POS Stock 同様）。
- **deploy**: `package.json` の `deploy:public` / `deploy:inhouse` から呼び、適切な toml とモードでデプロイ。

---

## 9. 責務分離のまとめ

| 層 | 責務 | 主な配置 |
|----|------|----------|
| **Admin App** | 設定・履歴・予算・テンプレートの編集・表示、プラン表示 | `app/routes/app.*`、`app/components/` |
| **Backend API** | 注文検索、精算・領収書・特殊返金・サマリー・設定の API、ジョブ起動 | `app/routes/api.*`、`app/services/` |
| **POS Extensions** | 4 タイルの UI と API 呼び出し、取引選択の共通化 | `extensions/*`、`extensions/common/` |
| **DB** | アプリ正本データの永続化、キャッシュ保存 | `prisma/schema.prisma`、`app/lib/db.ts` |
| **Jobs** | キャッシュ更新・アーカイブ・月次集計 | `app/routes/api.jobs.*` + Render Cron |

---

## 10. 公開用・自社用の切り替え（要件 0.1 対応）

- **POS 拡張**: `extensions/common/appUrl.js` の `APP_MODE` でベース URL を切り替え。公開用ビルドは `public`、自社用は `inhouse`。
- **Backend**: 環境変数 `APP_DISTRIBUTION=inhouse` のときはプラン制限なし（全機能 Pro 相当）。未設定 or `public` のときは Billing API でスタンダード/プロを判定。
- **設定ファイル**: 公開用 `shopify.app.public.toml`、自社用 `shopify.app.toml`。デプロイ時は `scripts/set-app-mode.js` と `deploy:public` / `deploy:inhouse` で統一。

---

## 11. 次のステップ

1. 本構成案の合意後、`prisma/schema.prisma` と初期マイグレーションを生成（Prompt 2 想定）。
2. 注文検索 API と取引選択 UI を先行実装（Prompt 3 想定）。
3. 順次、特殊返金・精算・領収書・売上サマリー・管理画面・Jobs を実装。

以上が技術スタック前提のプロジェクト構成と責務分離の提案です。
