# Shopify POS向け 日本商業施設対応アプリ 管理画面設定要件書 v2

## 0. 文書の目的
本書は、販売用 Shopify POS アプリにおける「管理画面で設定可能にすべき項目」を定義するための要件書である。

特に、既存の GAS 実装でコード直書きされている独自調整値・独自ロジックを、販売用アプリでは管理画面から設定変更できるようにするため、その置換対象を明確化する。

また、本書では `vip_points_used` のような特定ポイントアプリ依存の固定項目を廃止し、販売用として汎用化した `loyalty_usage` の考え方を採用する。

本書は以下を目的とする。

- コード直書きの運用差分を設定画面へ移行する
- ストアごとの差異を個別改修ではなく設定で吸収する
- Cursor が管理画面・設定テーブル・設定APIを実装しやすい状態にする
- 特定のポイントアプリや会員施策アプリへの依存を避ける

---

## 1. 前提方針

### 1.1 設定の基本方針
- ハードコードしない
- ストア単位 / ロケーション単位で設定可能にする
- 可能な限り管理画面から変更できるようにする
- MVP では複雑すぎる自由記述は避け、選択式 + 入力式を優先する

### 1.2 データ保存方針
設定の正本はアプリDBとする。

Shopify メタフィールドは以下の用途に限る。
- 注文に対する補助表示
- Shopify管理画面上での補助確認
- 監査補助

### 1.3 設定レベル
設定は以下の3階層を持つ。

- Shop 全体設定
- Location 個別設定
- 機能別設定

優先順位は以下とする。

1. Location 個別設定
2. Shop 全体設定
3. システムデフォルト

### 1.4 ポイント / 会員施策に関する前提
販売用アプリでは、`vip_points_used` のような特定アプリ依存の固定フィールドを標準項目としない。

代わりに、以下の論理項目を採用する。
- `loyalty_usage`

`loyalty_usage` は以下のような値を包括する概念である。
- VIPポイント利用額
- 会員ポイント利用額
- アプリポイント利用額
- 独自ロイヤルティ値引き額

どの値を `loyalty_usage` とみなすかは、管理画面設定で決定する。

---

## 2. 管理画面の構成

管理画面は以下のメニュー構成とする。

1. 一般設定
2. ロケーション設定
3. 精算設定
4. 支払方法マスタ設定
5. 商品券設定
6. 特殊返金設定
7. 領収書設定
8. ポイント / 会員施策設定
9. 売上サマリー設定
10. 予算設定
11. 印字設定

---

## 3. 一般設定

### 3.1 目的
アプリ全体に共通する基本設定を管理する。

### 3.2 設定項目

#### 3.2.1 アプリ基本情報
- app_display_name
- support_contact_email
- default_timezone
- default_currency

#### 3.2.2 プラン設定（表示用）
- current_plan_code (`standard` / `pro`)
- enabled_features_json

#### 3.2.3 表示言語
- admin_language
- pos_language

MVP では日本語固定でよいが、フィールドは将来の拡張用として持ってもよい。

#### 3.2.4 ログ / デバッグ設定
- debug_mode_enabled
- diagnostics_panel_enabled
- verbose_calc_log_enabled

### 3.3 受け入れ条件
- 設定保存後、各機能が同一 shop 内で参照できる
- debug_mode_enabled が ON の場合のみ診断情報表示が増える

---

## 4. ロケーション設定

### 4.1 目的
Shopify ロケーションごとの表示名や機能有効可否、運用差分を管理する。

### 4.2 設定項目

#### 4.2.1 ロケーション識別
- shopify_location_gid
- shopify_location_name
- display_location_name
- short_location_name
- sort_order

#### 4.2.2 機能有効可否
- settlement_enabled
- receipt_enabled
- special_refund_enabled
- voucher_adjustment_enabled
- sales_summary_enabled
- footfall_reporting_enabled
- inspection_receipt_enabled

#### 4.2.3 集計・表示対象制御
- include_in_store_totals
- include_in_overall_totals
- visible_in_summary_default

#### 4.2.4 印字関連
- print_mode (`cloudprnt_direct` / `order_based`)
- printer_profile_id_nullable
- cloudprnt_enabled

#### 4.2.5 売上サマリー関連
- summary_target_group_nullable
- budget_target_enabled
- footfall_target_enabled

### 4.3 GAS 由来の置換対象
現在の GAS の `LOCATION_LABELS` のようなマッピングは、以下へ置換する。

- shopify_location_name
- display_location_name
- short_location_name

### 4.4 受け入れ条件
- Shopify から取得した location を管理画面で一覧表示できる
- 表示名や並び順を変更できる
- ロケーション単位で機能 ON/OFF が反映される
- print_mode がロケーション単位で制御される

---

## 5. 精算設定

### 5.1 目的
精算レシートの項目表示、集計ルール、文言、出力仕様を管理する。

### 5.2 設定項目

#### 5.2.1 精算レシート基本
- settlement_receipt_title
- inspection_receipt_title
- default_settlement_note
- default_inspection_note

#### 5.2.2 表示項目 ON/OFF
- show_total
- show_net_sales
- show_tax
- show_discounts
- show_loyalty_usage
- show_order_count
- show_refund_count
- show_item_count
- show_payment_sections
- show_voucher_change
- show_as_of
- show_period_label
- show_location_label

#### 5.2.2A ポイント / 会員施策利用額設定
- loyalty_usage_feature_enabled
- loyalty_usage_label
- loyalty_usage_source_type (`discount_code_prefix` / `order_metafield` / `order_attribute` / `custom_app_event` / `manual_off`)
- loyalty_usage_source_config_json
- loyalty_usage_included_in_discount_breakdown
- loyalty_usage_show_as_separate_field

説明:
- `vip_points_used` のような固定フィールド名に依存しない
- 利用中のポイントアプリや会員施策アプリに応じて、どの値を「ポイント利用額」とみなすかを管理画面で設定する
- MVP では `discount_code_prefix` と `manual_off` を優先実装対象とする

#### 5.2.3 項目表示名
- label_total
- label_net_sales
- label_tax
- label_discounts
- label_loyalty_usage
- label_order_count
- label_refund_count
- label_item_count
- label_voucher_change

#### 5.2.4 項目順
- settlement_field_order_json
- payment_section_order_json

注意:
- `loyalty_usage` は固定の `vip_points_used` ではなく、設定に応じて表示する可変項目として扱う

#### 5.2.5 税計算表示
- tax_display_mode (`inclusive_only` / `inclusive_and_audit`)
- tax_rounding_mode (`round` / `floor` / `ceil`)

#### 5.2.6 精算再処理
- allow_recalculate_latest_settlement
- allow_reprint_settlement
- allow_manual_target_date

#### 5.2.7 非対応プリンタ時ルール
- order_based_create_settlement_order_enabled
- order_based_attach_metafields_enabled
- order_based_attach_note_enabled

### 5.3 GAS 由来の置換対象
以下のようなコード直書きは管理画面設定へ置換する。

- 精算レシートの表示名
- 精算レシートの表示項目
- payment sections の並び順
- 点検レシートの表題
- `vip_points_used` のような特定ポイントアプリ依存の名称・抽出ロジック

### 5.4 受け入れ条件
- 表示項目の ON/OFF がレシートプレビューへ反映される
- 項目名変更が反映される
- print_mode に応じて処理が切り替わる
- `loyalty_usage` の表示有無とラベル変更が反映される

---

## 6. 支払方法マスタ設定

### 6.1 目的
Shopify の gateway / formattedGateway を、アプリ内の表示名・分類・判定ロジックへマッピングする。

### 6.2 必要性
既存 GAS の `normalizeGatewayLabel()` は、コード内で多数の支払手段判定を行っている。
これを管理画面設定へ移すことで、導入先ごとの差異に対応する。

### 6.3 マスタ項目

#### 6.3.1 基本項目
- payment_method_id
- raw_gateway_pattern
- formatted_gateway_pattern_nullable
- display_label
- category
- sort_order
- enabled

#### 6.3.2 category 候補
- cash
- credit_card
- e_money
- qr
- transit_ic
- voucher
- paypal
- uncategorized

#### 6.3.3 商品券関連フラグ
- is_voucher
- voucher_change_supported
- voucher_no_change_supported

#### 6.3.4 特殊返金関連フラグ
- selectable_for_special_refund
- selectable_for_receipt_cash_adjustment
- selectable_for_payment_override

### 6.4 判定ルール設定
MVP ではルールは以下で十分。
- contains_match
- exact_match
- starts_with_match

### 6.5 置換対象
既存 GAS の以下を設定化する。
- `normalizeGatewayLabel` 内の raw / formattedGateway 判定
- `canonMethod` で許可している method 一覧
- 商品券 / 交通系 / 電子マネー / QR の分類

### 6.6 受け入れ条件
- 支払方法マスタ編集後、精算の payment sections ラベルに反映される
- 特殊返金画面で選択可能な手段が設定に従って変わる
- 商品券判定対象が設定に従って変わる

---

## 7. 商品券設定

### 7.1 目的
商品券釣有り・釣無し・額面読取・精算反映ルールを設定可能にする。

### 7.1A ポイント / 会員施策との関係
商品券機能とは別に、精算レシートや売上サマリーで表示する「ポイント利用額」「会員ポイント利用額」「アプリポイント利用額」等は、特定アプリ名に依存せず設定で吸収する。

このため、内部集計項目は `vip_points_used` ではなく、論理名として `loyalty_usage` を標準とする。

### 7.2 設定項目

#### 7.2.1 商品券機能全体
- voucher_feature_enabled
- voucher_auto_detection_enabled
- voucher_manual_adjustment_enabled

#### 7.2.2 額面読取ルール
- voucher_note_parse_enabled
- voucher_note_parse_regex
- voucher_default_label

#### 7.2.3 判定優先順位
- voucher_adjustment_priority (`manual_first` / `auto_first`)

#### 7.2.4 精算反映
- reflect_voucher_change_in_settlement
- reflect_voucher_change_in_receipt_display
- voucher_change_display_label

#### 7.2.5 商品券種別設定
- voucher_type_master_json

MVP では自由入力 JSON ではなく単純なテーブル実装でもよい。

### 7.3 GAS 由来の置換対象
以下を設定へ移す。
- `parseVoucherFaceFromNote()` の読取ルール
- 商品券釣有り / 釣無しキーワード群
- 自動判定有効 / 無効
- 手動調整優先の可否

### 7.4 受け入れ条件
- 商品券後処理イベントがある場合、それを優先して精算へ反映する
- 自動判定ルール変更がプレビューへ反映される

---

## 8. 特殊返金設定

### 8.1 目的
特殊返金機能で利用できるイベント種別や入力条件を管理する。

### 8.2 設定項目

#### 8.2.1 利用可能イベント種別
- enable_cash_refund
- enable_payment_method_override
- enable_voucher_change_adjustment
- enable_receipt_cash_adjustment

#### 8.2.2 event_type ごとの入力要件
- require_original_payment_method_for_payment_override
- require_actual_refund_method_for_payment_override
- require_note_for_cash_refund
- require_voucher_face_value_for_voucher_change_adjustment
- require_voucher_applied_amount_for_voucher_change_adjustment
- require_voucher_change_amount_for_voucher_change_adjustment

#### 8.2.3 精算反映
- reflect_cash_refund_to_settlement
- reflect_payment_override_to_settlement
- reflect_voucher_adjustment_to_settlement
- reflect_receipt_cash_adjustment_to_settlement

#### 8.2.4 表示名設定
- special_refund_ui_label
- voucher_adjustment_ui_label
- cash_refund_ui_label
- payment_override_ui_label

### 8.3 GAS 由来の置換対象
以下のような直書きを置換する。
- event_type の固定一覧
- method の固定一覧
- kind (`undo` / `extra`) の扱い

### 8.4 受け入れ条件
- OFF にしたイベント種別は POS UI に表示されない
- ON/OFF が API validation にも反映される

---

## 9. 領収書設定

### 9.1 目的
1テンプレ固定の領収書レイアウトを管理画面で編集できるようにする。

### 9.2 設定項目

#### 9.2.1 基本情報
- receipt_template_name
- receipt_logo_url
- issuer_company_name
- issuer_postal_code
- issuer_address_1
- issuer_address_2
- issuer_phone

#### 9.2.2 表示項目
- show_issue_date
- show_order_name
- show_location_name
- show_customer_name
- show_proviso
- show_amount
- show_tax_note
- show_reissue_mark

#### 9.2.3 デフォルト値
- default_proviso
- default_recipient_suffix

#### 9.2.4 レイアウト設定
- header_alignment
- logo_position
- company_info_position
- amount_emphasis_mode
- body_spacing

#### 9.2.5 文言設定
- receipt_title
- reissue_label
- tax_note_label
- currency_prefix

### 9.3 UI要件
- プレビューを見ながら編集可能
- 保存前プレビューと保存後プレビューが一致すること

### 9.4 GAS 由来の置換対象
現在コード直書きされがちな以下を設定化する。
- 会社名
- 郵便番号
- 住所
- 電話番号
- 表示順
- ラベル名

### 9.5 受け入れ条件
- 管理画面で変更した内容が領収書プレビューに即反映される
- 再発行表示文言を切り替えられる

---

## 9A. ポイント / 会員施策設定

### 9A.1 目的
ポイントアプリや会員施策アプリごとの差異を吸収し、精算・売上サマリー・領収書補助表示に使う「ポイント利用額」を設定可能にする。

### 9A.2 設定項目
- loyalty_usage_feature_enabled
- loyalty_usage_display_label
- loyalty_usage_source_type (`discount_code_prefix` / `order_metafield` / `order_attribute` / `custom_app_event` / `manual_off`)
- loyalty_usage_source_config_json
- loyalty_usage_discount_code_prefixes_json
- loyalty_usage_order_metafield_namespace_nullable
- loyalty_usage_order_metafield_key_nullable
- loyalty_usage_order_attribute_key_nullable
- loyalty_usage_include_in_summary
- loyalty_usage_include_in_settlement

### 9A.3 source_type の意味

#### discount_code_prefix
- 注文の discount code prefix を見て、該当値をポイント利用額として抽出する
- 例: `VIP-`, `POINT-`, `APP-`

#### order_metafield
- 注文メタフィールドから利用額を取得する

#### order_attribute
- 注文属性 / note attributes 等から利用額を取得する

#### custom_app_event
- アプリDBに保存された独自イベントから集計する

#### manual_off
- ポイント利用額の抽出を行わない

### 9A.4 GAS 由来の置換対象
- `vip_points_used`
- `VIP-` prefix 前提の割引判定
- 特定アプリ依存のポイント名称

### 9A.5 受け入れ条件
- 管理画面でポイント利用額の表示名を変更できる
- 管理画面で抽出元を切り替えできる
- ポイントアプリ未導入ストアでは無効化できる

---

## 10. 売上サマリー設定

### 10.1 目的
売上サマリー画面の表示内容や、入店数報告UIの有効 / 無効を制御する。

### 10.2 設定項目

#### 10.2.1 売上サマリー全体
- sales_summary_enabled
- allow_single_date_summary
- allow_date_range_summary

#### 10.2.2 表示対象
- show_location_rows
- show_store_totals
- show_overall_totals
- visible_location_ids_json

#### 10.2.3 KPI 表示制御
- show_budget
- show_actual
- show_budget_ratio
- show_orders
- show_visitors
- show_conv
- show_atv
- show_set_rate
- show_items
- show_unit_price
- show_month_budget
- show_month_actual
- show_month_achv_ratio
- show_progress_today
- show_progress_prev
- show_loyalty_usage
- loyalty_usage_summary_label

#### 10.2.4 入店数報告
- footfall_reporting_enabled
- footfall_reporting_target_location_ids_json
- footfall_report_editable_after_submit
- footfall_report_requires_confirmation

### 10.3 要件上の重要事項
入店数報告は独立タイルではなく、売上サマリー画面内の機能として扱う。

条件:
- `footfall_reporting_enabled = true` の場合のみ表示
- 対象ロケーションのみ入力可能

### 10.4 GAS 由来の置換対象
- 入店数報告対象店舗の固定化
- サマリー表示対象ロケーション
- KPI 表示項目の固定
- 合計表示の有無
- `vip_points_used` 固定表示

### 10.5 受け入れ条件
- 設定で OFF にすると入店数報告UIが非表示になる
- KPI ON/OFF が POS サマリー画面に反映される
- `loyalty_usage` 表示設定が反映される

---

## 11. 予算設定

### 11.1 目的
日別予算や期間予算を管理画面から登録・編集できるようにする。

### 11.2 設定・操作項目

#### 11.2.1 CSV操作
- download_budget_csv_template
- upload_budget_csv
- csv_column_mapping_enabled

#### 11.2.2 手動編集
- manual_budget_edit_enabled
- bulk_edit_enabled

#### 11.2.3 表示・適用
- budget_input_unit (`daily` / `monthly`)
- budget_apply_mode (`strict_daily` / `expand_from_monthly`)

### 11.3 CSV項目マッピング
最低限対応可能にする候補:
- date
- location
- budget
- visitors_target (optional)

### 11.4 GAS 由来の置換対象
- 予算シートの列名依存
- 店舗名の一致ロジック
- CSV列固定ルール

### 11.5 受け入れ条件
- CSVテンプレートをDLできる
- CSVアップロードで location + date 単位の upsert ができる
- エラー行が返る

---

## 12. 印字設定

### 12.1 目的
ロケーションやプリンタごとに、どの印字方式を使うかを管理する。

### 12.2 設定項目

#### 12.2.1 印字方式
- default_print_mode (`cloudprnt_direct` / `order_based`)
- location_print_mode_override_enabled

#### 12.2.2 CloudPRNT設定
- cloudprnt_profile_name
- cloudprnt_paper_width
- cloudprnt_enabled

#### 12.2.3 order-based設定
- create_settlement_order_when_printing
- attach_settlement_note_to_order
- attach_settlement_metafields_to_order

#### 12.2.4 領収書印字設定
- receipt_print_mode
- receipt_preview_before_print_required

### 12.3 GAS 由来の置換対象
- ロケーション別印字切替
- 非対応プリンタ時の精算注文生成有無

### 12.4 受け入れ条件
- ロケーション別 print_mode を切り替えられる
- cloudprnt_direct 設定時は精算注文を作成しない
- order_based 設定時は精算注文を利用する

---

## 13. 設定テーブル設計（推奨）

### 13.1 app_settings
- id
- shop_id
- key
- value_json
- created_at
- updated_at

用途:
- shop 全体の単純な設定値

### 13.2 location_settings
- id
- shop_id
- location_id
- key
- value_json
- created_at
- updated_at

用途:
- ロケーション別 override

### 13.3 payment_method_master
- id
- shop_id
- raw_gateway_pattern
- formatted_gateway_pattern_nullable
- match_type
- display_label
- category
- sort_order
- is_voucher
- voucher_change_supported
- selectable_for_special_refund
- selectable_for_receipt_cash_adjustment
- enabled
- created_at
- updated_at

### 13.4 receipt_templates
- id
- shop_id
- name
- template_json
- version
- is_active
- created_at
- updated_at

### 13.5 budgets
- id
- shop_id
- location_id
- target_date
- amount
- created_at
- updated_at

### 13.6 loyalty_settings_view (logical)
以下は app_settings / location_settings の組み合わせで表現してもよいが、実装上は論理的に以下の設定群を扱えること。
- loyalty_usage_feature_enabled
- loyalty_usage_display_label
- loyalty_usage_source_type
- loyalty_usage_source_config_json

---

## 14. GAS直書き項目 → 管理画面設定 置換表

### 14.1 ロケーションマッピング
GAS:
- `LOCATION_LABELS`

置換先:
- ロケーション設定
  - display_location_name
  - short_location_name
  - sort_order

### 14.2 支払方法正規化
GAS:
- `normalizeGatewayLabel()`

置換先:
- 支払方法マスタ設定
  - raw_gateway_pattern
  - formatted_gateway_pattern
  - display_label
  - category
  - voucher flags

### 14.3 特殊返金対象 method
GAS:
- `canonMethod()`

置換先:
- 支払方法マスタ設定
  - selectable_for_receipt_cash_adjustment
  - selectable_for_special_refund

### 14.4 商品券額面読取
GAS:
- `parseVoucherFaceFromNote()`

置換先:
- 商品券設定
  - voucher_note_parse_enabled
  - voucher_note_parse_regex

### 14.4A ポイント利用額抽出
GAS:
- `vip_points_used`
- `VIP-` prefix 前提の割引判定

置換先:
- ポイント / 会員施策設定
  - loyalty_usage_source_type
  - loyalty_usage_discount_code_prefixes_json
  - loyalty_usage_display_label

### 14.5 サマリー対象店舗 / 入店数対象店舗
GAS:
- 店舗ごとの固定分岐

置換先:
- ロケーション設定
- 売上サマリー設定

### 14.6 領収書会社情報
GAS / テンプレ直書き:
- 会社名
- 郵便番号
- 住所
- 電話番号

置換先:
- 領収書設定

### 14.7 印字方式分岐
GAS:
- CloudPRNT / 非対応の処理分岐

置換先:
- 印字設定
- ロケーション設定

---

## 15. Cursor向け 実装優先順

### Phase 1
- location_settings
- app_settings
- payment_method_master
- receipt_templates
- settings API 基盤

### Phase 2
- ロケーション設定画面
- 支払方法マスタ設定画面
- 印字設定画面

### Phase 3
- 領収書設定画面 + プレビュー
- 売上サマリー設定画面
- ポイント / 会員施策設定画面
- 予算設定画面

### Phase 4
- 商品券設定画面
- 特殊返金設定画面
- GAS 直書きロジックの設定参照化

---

## 16. Cursor向け 実装指示テンプレート

### Prompt 1
この設定要件書を元に、app_settings / location_settings / payment_method_master / receipt_templates の DB schema を作成してください。MVP で必要な index と unique 制約も含めてください。

### Prompt 2
この設定要件書を元に、管理画面の設定一覧 API と更新 API を実装してください。shop 全体設定と location override の優先順位を考慮してください。

### Prompt 3
ロケーション設定画面、印字設定画面、支払方法マスタ設定画面を実装してください。支払方法マスタは raw_gateway_pattern / formatted_gateway_pattern / display_label / category / flags を編集可能にしてください。

### Prompt 4
領収書設定画面を実装してください。テンプレートは1つ固定で、会社情報・ロゴ・文言・表示ON/OFF・簡易プレビューを編集できるようにしてください。

### Prompt 5
売上サマリー設定画面、ポイント / 会員施策設定画面、予算設定画面を実装してください。入店数報告のON/OFF、ポイント利用額の抽出元設定、CSVテンプレート経由の予算アップロードを含めてください。

### Prompt 6
既存の集計・特殊返金・商品券判定ロジックが、ハードコードではなく設定テーブルを参照するように置き換えてください。特に location mapping, payment label normalization, voucher parsing, loyalty usage extraction, print mode branching を対象にしてください。

---

## 17. 最終決定事項

- GAS で独自調整している部分は、販売用では可能な限り管理画面設定へ置換する
- ロケーション名対応、支払方法正規化、商品券判定、印字分岐、領収書会社情報、ポイント利用額抽出ロジックは設定対象に含める
- 入店数報告は売上サマリー内の機能とし、設定 ON 時のみ表示する
- CloudPRNT direct / order-based はロケーション設定で切り替え可能にする
- 領収書テンプレートは1つ固定だが、管理画面でプレビューしながら編集可能とする
- ポイント利用額は `vip_points_used` のような特定アプリ依存の固定項目ではなく、設定可能な `loyalty_usage` として扱う

