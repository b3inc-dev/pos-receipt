# POS Receipt アプリ 進捗サマリー

要件書 `posreceipt_requirements_spec.md` に基づく実装進捗です。  
最終更新: 2025-03-10

---

## 1. 全体の進捗イメージ

| フェーズ | 状態 | 内容 |
|----------|------|------|
| **Epic A. 基盤構築** | ✅ 完了 | App scaffold / DB / 認証 / 公開用・自社用分離 |
| **Epic B. 注文検索・取引選択** | ✅ 完了 | 注文検索API・取引一覧・取引詳細起動 |
| **Epic C. 精算** | ⬜ 未着手 | 精算エンジン・印字分岐・点検レシート |
| **Epic D. 特殊返金・商品券調整** | ⬜ 次に実装 | イベントAPI・POS UI（4種） |
| **Epic E. 領収書** | ⬜ 未着手 | プレビュー・発行・テンプレート編集 |
| **Epic F. 売上サマリー** | ⬜ 未着手 | サマリーAPI・予算・入店数・キャッシュ |
| **Epic G. プラン制御** | ⬜ 未着手 | スタンダード/プロの機能制御 |
| **Epic H. 品質・運用** | 一部 | audit columns は Prisma に定義済み |

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

### 2.3 ドキュメント・デプロイ
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
