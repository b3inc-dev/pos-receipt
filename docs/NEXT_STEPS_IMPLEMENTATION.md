# POS Receipt 残り実装の進め方

このドキュメントは、Epic A〜H 完了後の「残タスク」とオプション項目の進め方をまとめたものです。  
最終更新: 2026-03-12

---

## 1. POS タイルの UID 設定（確認・再取得手順）

### 現状

`extensions/pos-smart-grid/shopify.extension.toml` には、**4 つすべてのタイルに UID がすでに設定済み**です。

| タイル名           | handle              | UID（設定済み） |
|--------------------|---------------------|----------------------------------|
| 特殊返金・商品券調整 | pos-special-refund  | 149c1d23-b280-f51c-42ee-...      |
| 精算レシート       | pos-settlement      | 7c9e0f75-5a2c-efb4-d535-...      |
| 領収書発行         | pos-receipt-issue   | 48eb3dec-21ec-8072-0dc9-...      |
| 売上サマリー表示   | pos-sales-summary   | dfcb6e02-8400-c5bb-b42a-...      |

**やること**: 通常はこのままで問題ありません。  
**新規アプリで同じ拡張を登録し直す場合**や、パートナーダッシュボードで拡張を削除して作り直した場合は、以下で UID を再取得し、`shopify.extension.toml` の該当 `[[extensions]]` の `uid` を書き換えてください。

### UID を再取得する手順

1. プロジェクトルートで次を実行（タイルごとに 1 回ずつ）:
   ```bash
   cd /Users/develop/ShopifyApps/pos-receipt
   shopify app generate extension --type ui_extension --name "精算レシート"
   shopify app generate extension --type ui_extension --name "領収書発行"
   shopify app generate extension --type ui_extension --name "売上サマリー表示"
   ```
2. コマンド実行後、新規作成される `shopify.extension.toml` に `uid = "..."` が出力されます。
3. **既存の pos-smart-grid は 1 つの extension に複数ターゲットをまとめているため**、新規フォルダは使わず、表示された **UID の値だけをコピー**し、`extensions/pos-smart-grid/shopify.extension.toml` の該当ブロックの `uid` に貼り付けて保存します。
4. `shopify app deploy` または `shopify app dev` で反映を確認します。

---

## 2. オプション項目の進め方

### 2.1 location_settings の key-value テーブル（必要になったら）

- **要件書**: §13.2 で「location_settings テーブル」が推奨されています。
- **現状**: `Location` モデルに、表示名・印字方式・サマリー対象・CloudPRNT 有効など**固定カラムで代替**済み（`docs/SETTINGS_REQUIREMENTS_COVERAGE.md` 参照）。key-value の汎用テーブルは未作成。
- **進め方**: 新しい「ロケーション別の key」を増やしたいタイミングで、`LocationSetting` のような key-value テーブルを追加し、設定画面・API から読み書きする実装にすればよいです。現時点では必須ではありません。

### 2.2 税率の設定化 ✅ 実装済み

- **実装内容**:
  - 精算設定に `taxRatePercent`（0〜100、デフォルト 10）を追加。
  - 管理画面「精算設定」の「税・再処理・非対応プリンタ時」に「消費税率（%）」入力欄を追加。
  - 精算エンジン `buildSettlementPreview` で `getAppSetting(shopId, SETTLEMENT_SETTINGS_KEY)` から `taxRatePercent` を取得し、`tax = effectiveGross * taxRatePercent / (100 + taxRatePercent)` で算出。

### 2.3 支払方法マスタの選択肢・商品券判定の拡張 ✅ 実装済み

- **実装内容**:
  - **分類**: 「商品券」を「商品券・ギフトカード」に変更。一覧に「商品券」「釣銭あり」列を追加し、一覧で判定が分かるようにした。
  - **商品券判定**: 「商品券として扱う」に説明文を追加（gateway に gift_card 等を登録してONにする旨）。`formattedGatewayPattern` が空のときは formatted ではマッチしないよう `paymentMethod.server.ts` のマッチングを修正。
  - **API**: `getPaymentMethodVoucherInfo(shopId, gateway)` を追加。gateway に一致するマスタの `isVoucher` / `voucherChangeSupported` を返し、特殊返金・精算で利用可能。

### 2.4 CloudPRNT 実機連携（payload をプリンタに送る導線） ✅ 実装済み

- **実装内容**:
  1. **印字用 payload の生成と返却** ✅
     - `app/services/settlementEngine.server.ts` に `buildSettlementReceiptText(preview)` を追加。精算レシート本文（注文ノートと同じ内容）を 1 本のテキストで組み立て。
     - `POST /api/settlements/create` で `printMode === "cloudprnt_direct"` のとき、レスポンスに `printPayload: string` を含める。
  2. **ポーリング用エンドポイント** ✅
     - `GET /api/settlements/:id/print-payload` を追加。指定精算の印字用テキストを `{ ok: true, printPayload: string }` で返す。プリンタやミドルウェアがこの URL を叩いて payload を取得できる。

**POS 導線** ✅: CloudPRNT 直印字の完了画面で、印字用データ取得URL（`GET /api/settlements/:id/print-payload`）を表示。実機確認時にプリンタのポーリング先に設定できる旨を案内。

**残り（オプション）**:
- **A. POS から送る**: create 成功後の `printPayload` を Star の POS 用 SDK 等で直接プリンタに送る導線（実機・SDK に合わせて実装）。
- 実機での印字確認。

---

## 3. 実装の優先順位の提案

| 優先度 | 項目                         | 状態 |
|--------|------------------------------|------|
| 高     | CloudPRNT payload の生成・返却 | ✅ 完了 |
| 中     | CloudPRNT 実機への送信導線   | ポーリング用 GET・POS 完了画面の URL 案内まで完了。実機確認は後述 |
| 中     | 税率の設定化                 | ✅ 完了 |
| 低     | 支払方法マスタ・商品券の拡張 | ✅ 完了（一覧列・説明・VoucherInfo API） |
| 低     | location_settings key-value  | 新しいロケーション別設定が必要になったら対応 |

---

## 4. 関連ファイル一覧

| 目的                 | ファイル・場所 |
|----------------------|----------------|
| タイル UID           | `extensions/pos-smart-grid/shopify.extension.toml` |
| 精算・税率計算       | `app/services/settlementEngine.server.ts` |
| 精算 create・payload | `app/routes/api.settlements.create.tsx` |
| 精算 印字 payload 取得 | `app/routes/api.settlements.$id.print-payload.tsx`（GET） |
| 精算設定（税率追加候補） | `app/utils/appSettings.server.ts`, `app/routes/app.settlement-settings.tsx` |
| 支払方法マスタ       | `app/routes/app.payment-methods.tsx`, `app/utils/paymentMethod.server.ts`, Prisma `PaymentMethodMaster` |
| 印字設定・CloudPRNT  | `app/routes/app.print-settings.tsx`, `app/utils/appSettings.server.ts` (PrintSettings) |
| POS 精算 UI          | `extensions/pos-smart-grid/src/SettlementModal.jsx` |

---

進捗に合わせて、このドキュメントと `PROGRESS_SUMMARY.md` の「次のステップ」を更新してください。
