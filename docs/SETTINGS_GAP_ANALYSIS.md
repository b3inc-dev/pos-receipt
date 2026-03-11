# 設定要件書（posreceipt_settings_detail.md）とのギャップ分析

`posreceipt_settings_detail.md` に基づき、未実装・不足している箇所を洗い出した一覧です。実装は **Section 15 の Phase 1 → Phase 2 → Phase 3 → Phase 4** の順で進めます。

---

## 1. 管理画面メニュー構成（要件 §2）

| # | 要件のメニュー | 現状 | ギャップ |
|---|----------------|------|----------|
| 1 | 一般設定 | なし（設定ページにプランのみ） | 一般設定専用セクションまたはページなし。app_display_name, support_contact_email, default_timezone, debug_mode 等なし |
| 2 | ロケーション設定 | 設定ページに一部あり | 表示名・短縮名・並び順・機能有効可否の一部のみ。§4.2 の多くが未実装 |
| 3 | 精算設定 | なし | 精算レシートの表題・表示項目ON/OFF・項目表示名・順・税表示・loyalty_usage 等の設定画面なし |
| 4 | 支払方法マスタ設定 | なし | DB テーブルなし・画面なし |
| 5 | 商品券設定 | あり（/app/voucher-settings） | §7 の項目を AppSetting で保存 |
| 6 | 特殊返金設定 | あり（/app/special-refund-settings） | §8 のイベント種別・入力要件・表示名を AppSetting で保存。API で参照 |
| 7 | 領収書設定 | 領収書テンプレート画面あり | §9.2 の項目の多くが未実装（後述） |
| 8 | ポイント/会員施策設定 | あり（/app/loyalty-settings） | §9A の表示名・抽出元を AppSetting で保存。API側での参照は今後の実装で対応可能 |
| 9 | 売上サマリー設定 | あり（/app/sales-summary-settings） | §10.2 の項目を AppSetting で保存。API側での参照は今後の実装で対応可能 |
| 10 | 予算設定 | 予算管理ページあり | CSV・手動編集・表示単位は一部あり。要件との完全一致は要確認 |
| 11 | 印字設定 | 設定ページでロケーション別印字方式のみ | ショップ全体のデフォルト・CloudPRNT詳細・領収書印字設定なし |

---

## 2. DB スキーマ（要件 §13）

| 要件 | 現状 | ギャップ |
|------|------|----------|
| **app_settings** | `AppSetting` あり (shop_id, key, value_json) | ✅ あり。key の定義・利用が未整備の可能性 |
| **location_settings** | なし。`Location` は固定カラムのみ | ❌ key-value の location_settings テーブルなし。Location には name, code, printMode, salesSummaryEnabled, footfallReportingEnabled のみで、§4.2 の display_location_name, short_location_name, sort_order, settlement_enabled, receipt_enabled 等が不足 |
| **payment_method_master** | なし | ❌ テーブルなし。§13.3 の全項目を新規作成必要 |
| **receipt_templates** | `ReceiptTemplate` あり (name, templateJson, version, isActive) | ✅ あり。templateJson の項目が §9.2 と比べて不足（後述） |
| **budgets** | `Budget` あり | ✅ あり |

---

## 3. ロケーション設定（要件 §4）

- **4.2.1 ロケーション識別**  
  - 実装済み: shopify_location_gid, name（Shopify の name）  
  - 未実装: **display_location_name**, **short_location_name**, **sort_order**
- **4.2.2 機能有効可否**  
  - 実装済み: sales_summary_enabled, footfall_reporting_enabled（Location の salesSummaryEnabled, footfallReportingEnabled）  
  - 未実装: **settlement_enabled**, **receipt_enabled**, **special_refund_enabled**, **voucher_adjustment_enabled**, **inspection_receipt_enabled**
- **4.2.3 集計・表示対象制御**  
  - 未実装: **include_in_store_totals**, **include_in_overall_totals**, **visible_in_summary_default**
- **4.2.4 印字関連**  
  - 実装済み: print_mode（Location.printMode）  
  - 未実装: **printer_profile_id_nullable**, **cloudprnt_enabled**
- **4.2.5 売上サマリー関連**  
  - 未実装: **summary_target_group_nullable**, **budget_target_enabled**, **footfall_target_enabled**

---

## 4. 支払方法マスタ（要件 §6, §13.3）

- **テーブル全体が未実装。**  
  必要項目: shop_id, raw_gateway_pattern, formatted_gateway_pattern_nullable, match_type, display_label, category, sort_order, is_voucher, voucher_change_supported, selectable_for_special_refund, selectable_for_receipt_cash_adjustment, enabled, created_at, updated_at  
  （商品券・特殊返金用フラグは §6.3.3, §6.3.4 参照）
- **管理画面**  
  支払方法マスタの一覧・追加・編集・有効/無効の画面がなし。

---

## 5. 領収書設定（要件 §9.2） — ✅ 対応済み（Phase 3）

テンプレート項目（ReceiptTemplate.templateJson / DEFAULT_TEMPLATE）を §9.2 に合わせて拡張済み。

- **9.2.1 基本情報**: receiptTemplateName, logoUrl, companyName, postalCode, address, address2, phone
- **9.2.2 表示項目**: showIssueDate, showOrderName, showLocationName, showCustomerName, showProviso, showAmount, showTaxNote, showReissueMark
- **9.2.3 デフォルト値**: defaultProviso, defaultRecipientSuffix
- **9.2.4 レイアウト**: headerAlignment, logoPosition, companyInfoPosition, amountEmphasisMode, bodySpacing
- **9.2.5 文言**: receiptTitle, reissueLabel, taxNoteLabel, currencyPrefix

管理画面のプレビューは上記設定に従い描画し、保存前・保存後で同一内容になるよう同一ロジックを使用（§9.3）。

---

## 6. その他未実装

- **一般設定（§3）**  
  app_settings に key で保存する想定で、画面・key 定義が未整備。
- **精算設定（§5）**  
  表題・表示項目ON/OFF・項目表示名・順・税表示・loyalty_usage 設定・再処理許可など、すべて設定画面・app_settings/location_settings の key 設計が未実装。
- **商品券設定（§7）**  
  設定画面・key 設計とも未実装。
- **特殊返金設定（§8）**  
  イベント種別ON/OFF・入力要件・表示名の設定画面未実装。
- **ポイント/会員施策設定（§9A）**  
  loyalty_usage の表示名・抽出元（discount_code_prefix 等）の設定画面未実装。
- **売上サマリー設定（§10）**  
  表示対象・KPI表示制御・入店数報告の詳細設定画面未実装。
- **印字設定（§12）**  
  ショップ全体の default_print_mode、CloudPRNT 詳細、領収書印字設定が未実装。

---

## 7. 実装優先順（要件 §15 に沿った順序）

1. **Phase 1**  
   - location_settings（Location 拡張 または LocationSetting テーブル）  
   - app_settings（既存のまま利用、key 定義を整備）  
   - **payment_method_master の新規作成**  
   - receipt_templates（既存のまま、templateJson の項目拡張）  
   - 設定取得/更新 API 基盤（必要に応じて共通化）

2. **Phase 2**  
   - ロケーション設定画面の拡張（表示名・並び順・§4.2 の機能有効可否など）  
   - 支払方法マスタ設定画面の新規作成  
   - 印字設定画面（または設定ページ内セクション拡張）

3. **Phase 3**  
   - 領収書設定画面の項目拡張（§9.2 全項目）＋ プレビュー一致  
   - 売上サマリー設定画面  
   - ポイント/会員施策設定画面  
   - 予算設定画面（既存の予算管理ページとの整合）

4. **Phase 4**  
   - 商品券設定画面  
   - 特殊返金設定画面  
   - GAS 直書きロジックの設定参照化（精算・支払ラベル・商品券・印字分岐など）

---

## 8. 次のアクション（推奨）

1. ~~**Phase 1**~~ **済**  
   - ✅ `PaymentMethodMaster` モデルを Prisma に追加（マイグレーション `20260312000000_add_payment_method_master_and_location_settings`）。  
   - ✅ Location に `displayName`, `shortName`, `sortOrder` および §4.2.2 のフラグ（settlementEnabled, receiptEnabled, specialRefundEnabled, voucherAdjustmentEnabled, inspectionReceiptEnabled）を追加。  
   - 領収書テンプレートの §9.2 不足項目は Phase 3 で対応。

2. ~~**Phase 2（一部）**~~ **済**  
   - ✅ 支払方法マスタの CRUD API（`/api/settings/payment-methods`, `/api/settings/payment-methods/:id`）と管理画面（`/app/payment-methods`）を新規作成。  
   - ✅ 設定ページのロケーション設定を拡張（表示名・短縮名・並び順・機能有効可否）。

3. ~~**Phase 3（領収書・売上サマリー・ポイント）**~~ **済**  
   - ✅ 領収書テンプレート画面に §9.2 の全項目を追加。プレビューを設定に従い描画し保存前後で一致。  
   - ✅ 売上サマリー設定画面（`/app/sales-summary-settings`）：§10.2 の全体・表示対象・KPI表示制御・入店数報告を AppSetting で保存。  
   - ✅ ポイント/会員施策設定画面（`/app/loyalty-settings`）：§9A の loyalty_usage 表示名・抽出元（discount_code_prefix / manual_off 等）を AppSetting で保存。

4. ~~**Phase 4**~~ **済**  
   - ✅ 商品券設定画面（`/app/voucher-settings`）、特殊返金設定画面（`/app/special-refund-settings`）を追加。AppSetting で保存。  
   - ✅ 設定の参照: 売上サマリー API で sales_summary_settings（表示対象・displayOptions）を参照。精算エンジンで支払方法マスタ・loyalty_settings の表示ラベルを参照。特殊返金 API で有効イベント種別・表示名を special_refund_settings から取得。

このドキュメントは実装の進捗に合わせて更新してください。
