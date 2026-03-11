# POS Receipt アプリ 進捗サマリー

要件書 `posreceipt_requirements_spec.md` に基づく実装進捗です。  
最終更新: 2026-03-12

---

## 1. 全体の進捗イメージ

| フェーズ | 状態 | 内容 |
|----------|------|------|
| **Epic A. 基盤構築** | ✅ 完了 | App scaffold / DB / 認証 / 公開用・自社用分離 |
| **Epic B. 注文検索・取引選択** | ✅ 完了 | 注文検索API・取引一覧・取引詳細起動 |
| **Epic C. 精算** | ✅ 完了 | 精算エンジン・印字分岐・点検レシート |
| **Epic D. 特殊返金・商品券調整** | ✅ 完了 | イベントAPI・POS UI（4種） |
| **Epic E. 領収書** | ✅ 完了 | プレビュー・発行・テンプレート編集 |
| **Epic F. 売上サマリー** | ✅ 完了 | サマリーAPI・予算・入店数・キャッシュ |
| **Epic G. プラン制御** | ✅ 完了 | スタンダード/プロの機能制御・Billing API |
| **Epic H. 品質・運用** | ✅ 完了 | 管理画面履歴・予算管理・Retry UI・Seed data |

---

## 2. 実装済み（Prompt 1〜3 + Phase 1）

### 2.1 基盤
- **Prisma スキーマ**  
  `prisma/schema.prisma` に要件書 20 章どおりのモデル定義済み  
  （Shop, Location, AppSetting, Settlement, SpecialRefundEvent, ReceiptTemplate, ReceiptIssue, Budget, FootfallReport, SalesSummaryCacheDaily/Period）
- **認証・セッション**  
  `app/shopify.server.ts`、PrismaSessionStorage、auth ルート
- **公開用・自社用**  
  `shopify.app.public.toml` / `shopify.app.toml`、`extensions/common/appUrl.js`（APP_MODE, getAppUrl）

### 2.2 注文検索・取引選択（Prompt 3）
- **API**
  - `GET /api/orders/search` … q, locationId, dateFrom, dateTo, cursor, limit
  - `GET /api/orders/:orderId` … 注文詳細（transactions, refunds, lineItems 等）
- **POS**
  - `extensions/common/orderPickerApi.js` … searchOrders, getOrder
  - `extensions/pos-smart-grid/src/Modal.jsx` … 検索フォーム・結果一覧・取引選択
  - `extensions/pos-smart-grid/src/OrderAction.jsx` … 取引詳細画面から「この取引で開く」

### 2.3 設定要件書（posreceipt_settings_detail.md）対応
- **Phase 1〜2**  
  - `PaymentMethodMaster` テーブル追加、Location に表示名・並び順・機能有効フラグ追加（§4, §13.3）  
  - 支払方法マスタ設定画面（`/app/payment-methods`）と API（GET/POST/PATCH/DELETE）  
  - 設定ページのロケーション設定を拡張（表示名・短縮名・並び順・精算/領収書/特殊返金/商品券/点検の ON/OFF）
- **Phase 3（領収書・売上サマリー・ポイント）**  
  - 領収書テンプレートを §9.2 全項目対応。管理画面プレビューを保存前後で一致（§9.3）  
  - 売上サマリー設定（`/app/sales-summary-settings`）：§10 の表示・KPI・入店数報告を AppSetting で保存  
  - ポイント/会員施策設定（`/app/loyalty-settings`）：§9A の loyalty_usage 表示名・抽出元を AppSetting で保存  
- **Phase 4（設定参照・商品券・特殊返金）**  
  - 売上サマリー API（daily/period）で sales_summary_settings を参照（表示対象ロケーション・displayOptions 返却）  
  - 精算エンジンで支払方法マスタの表示ラベル・loyalty_settings の表示ラベルを参照  
  - 特殊返金 API で special_refund_settings から有効イベント種別・UI ラベルを取得  
  - 商品券設定（`/app/voucher-settings`）、特殊返金設定（`/app/special-refund-settings`）画面を追加  
- **全設定画面の網羅（§3・§5・§11・§12・§4.2.3〜4.2.5）**  
  - 一般設定（`/app/general-settings`）：アプリ表示名・連絡先・タイムゾーン・通貨・プラン・言語・デバッグ（AppSetting `general_settings`）  
  - 精算設定（`/app/settlement-settings`）：表題・表示項目ON/OFF・項目名・項目順・税表示・再処理・order_based ルール（AppSetting `settlement_settings`）  
  - 印字設定（`/app/print-settings`）：デフォルト印字方式・ロケーション上書き・CloudPRNT・order-based・領収書印字（AppSetting `print_settings`）  
  - 予算設定（`/app/budget-settings`）：CSVマッピング・手動/一括編集・input_unit・apply_mode（AppSetting `budget_settings`）  
  - ロケーション設定：§4.2.3（店舗/全体合計・サマリー表示）、§4.2.4（printer_profile_id, cloudprnt_enabled）、§4.2.5（summary_target_group, budget_target_enabled, footfall_target_enabled）を Location に追加・設定ページで編集  
- ギャップ一覧: `docs/SETTINGS_GAP_ANALYSIS.md`、網羅状況: `docs/SETTINGS_REQUIREMENTS_COVERAGE.md`

### 2.4 ドキュメント・デプロイ
- Render 手順: `RENDER_SETUP.md`, `RENDER_DATABASE_URL.md`, `NEXT_STEPS_AFTER_RENDER.md`
- 構成案: `PROJECT_STRUCTURE_PROPOSAL.md`、DB: `DB_MIGRATION.md`

---

## 3. 次のステップ（推奨順）

### 直近: Prompt 4 — 特殊返金・商品券調整
- **Backend**
  - `POST /api/special-refunds` … イベント作成（event_type 4種）
  - `GET /api/special-refunds?orderId=...` … 注文に紐づくイベント一覧
  - `POST /api/special-refunds/:id/void`（または PATCH status=voided）… 無効化
- **event_type**  
  `cash_refund` / `payment_method_override` / `voucher_change_adjustment` / `receipt_cash_adjustment`
- **POS UI**  
  取引選択後 → 「特殊返金」 or 「商品券調整」選択 → 種別ごとの入力フォーム → 確認・実行  
  （既存の Modal.jsx の「選択した取引」の先に画面を追加）

### その後
- **Prompt 5**: 精算（プレビューAPI、create、print adapter、cloudprnt_direct / order_based）
- **Prompt 6**: 領収書（テンプレート編集、プレビュー、発行、履歴）
- **Prompt 7**: 売上サマリー（日次/期間API、予算、入店数、キャッシュ、管理画面設定）

---

## 4. 主要ファイル参照

| 種類 | パス |
|------|------|
| 要件書 | `docs/posreceipt_requirements_spec.md` |
| DB | `prisma/schema.prisma` |
| 注文検索API | `app/routes/api.orders.search.tsx`, `app/routes/api.orders.$orderId.tsx` |
| POS 共通API | `extensions/common/orderPickerApi.js`, `extensions/common/appUrl.js` |
| POS モーダル | `extensions/pos-smart-grid/src/Modal.jsx` |
| 取引詳細アクション | `extensions/pos-smart-grid/src/OrderAction.jsx` |
| API 仕様（要件書） | 第 21 章（21.4 特殊返金API） |
| データモデル（要件書） | 第 20 章（20.5 special_refund_events） |

---

## 5. 進捗の更新のしかた

実装が進んだら、このファイルと `posreceipt_requirements_spec.md` の **30. 実装済み内容** をあわせて更新してください。
