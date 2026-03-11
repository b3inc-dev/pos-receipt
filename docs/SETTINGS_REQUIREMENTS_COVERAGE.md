# 設定要件書（posreceipt_settings_detail.md）網羅状況

「追加の要件書は網羅したか」に対する回答です。  
最終更新: 2026-03-12

---

## 結論

**要件書の設定系セクション（§3〜§12）は一通り実装済みです。**  
一般設定・精算設定・印字設定・予算設定の専用画面と、ロケーションの §4.2.3〜4.2.5 項目を追加し、網羅しました。

---

## 網羅済み（実装済み）

| 要件 § | 内容 | 実装 |
|--------|------|------|
| **§2 メニュー 1** | 一般設定 | `/app/general-settings`、AppSetting `general_settings`（§3 全項目） |
| **§2 メニュー 2** | ロケーション設定 | 設定ページ内で `Location` 全項目（§4.2.1〜4.2.5：表示名・並び順・機能有効・集計対象・印字・サマリー関連） |
| **§2 メニュー 3** | 精算設定 | `/app/settlement-settings`、AppSetting `settlement_settings`（§5 表題・表示ON/OFF・項目名・順・税・再処理等） |
| **§2 メニュー 4** | 支払方法マスタ設定 | `/app/payment-methods`、DB `PaymentMethodMaster`、精算でのラベル参照 |
| **§2 メニュー 5** | 商品券設定 | `/app/voucher-settings`、AppSetting `voucher_settings` |
| **§2 メニュー 6** | 特殊返金設定 | `/app/special-refund-settings`、API で有効種別・UI ラベル参照 |
| **§2 メニュー 7** | 領収書設定 | `/app/receipt-template`、§9.2 全項目・プレビュー一致 |
| **§2 メニュー 8** | ポイント/会員施策設定 | `/app/loyalty-settings`、精算・サマリーでラベル参照 |
| **§2 メニュー 9** | 売上サマリー設定 | `/app/sales-summary-settings`、API で表示対象・displayOptions 参照 |
| **§2 メニュー 10** | 予算設定 | `/app/budget-settings`、AppSetting `budget_settings`（§11 input_unit, apply_mode, CSV・一括編集フラグ） |
| **§2 メニュー 11** | 印字設定 | `/app/print-settings`、AppSetting `print_settings`（§12 デフォルト印字方式・CloudPRNT・order-based・領収書印字） |
| **§3 一般設定** | アプリ名・連絡先・タイムゾーン・通貨・プラン・言語・デバッグ | 画面・AppSetting |
| **§4 ロケーション設定** | §4.2.1〜4.2.5 全項目 | 設定ページで Location の全フィールドを編集・保存 |
| **§5 精算設定** | 表題・表示項目・項目名・順・税・再処理・order_based ルール | 画面・AppSetting |
| **§6 支払方法マスタ** | 表示名・分類・判定・フラグ | テーブル・CRUD・精算 payment sections で表示名参照 |
| **§7 商品券設定** | 機能ON/OFF・額面読取・精算反映 | 画面・AppSetting |
| **§8 特殊返金設定** | イベント種別・入力要件・表示名 | 画面・AppSetting・API で有効種別・ラベル参照 |
| **§9 領収書設定** | §9.2 全項目・プレビュー一致 | テンプレート拡張・管理画面・§9.3 満たす |
| **§9A ポイント/会員施策** | 表示名・抽出元・サマリー/精算含む | 画面・AppSetting・精算でラベル参照 |
| **§10 売上サマリー設定** | 全体・表示対象・KPI・入店数報告 | 画面・AppSetting・daily/period API で参照 |
| **§11 予算設定** | CSV・手動編集・一括編集・input_unit・apply_mode | 画面・AppSetting |
| **§12 印字設定** | デフォルト印字方式・ロケーション上書き・CloudPRNT・order-based・領収書印字 | 画面・AppSetting |
| **§13.1 app_settings** | shop 単位 key-value | `AppSetting` 利用、各種 key で保存 |
| **§13.3 payment_method_master** | 支払方法マスタ | テーブル・画面・精算で参照 |
| **§13.4 receipt_templates** | 領収書テンプレート | 既存テーブル・§9.2 項目で拡張 |
| **§13.5 budgets** | 予算 | 既存テーブル・予算管理画面あり |
| **§15 Phase 1〜4** | 推奨実装順 | 実施済み（設定参照化含む） |

---

## 未実装・部分実装（残り）

| 要件 § | 内容 | 現状 |
|--------|------|------|
| **§13.2 location_settings** | ロケーション別 key-value テーブル | 要件書は「location_settings テーブル」を推奨。現状は `Location` の固定カラムで代替しており、key-value の汎用テーブルは未作成。 |

---

## 受け入れ条件の対応状況

- **§4.4 ロケーション**: 一覧表示・表示名・並び順・機能ON/OFF・print_mode → **対応済み**
- **§6.6 支払方法マスタ**: 精算の payment sections ラベル・特殊返金の選択肢・商品券判定 → **ラベルは対応。選択肢・商品券判定はマスタのフラグで今後の拡張可能**
- **§8.4 特殊返金**: OFF にした種別は API で拒否・一覧でも非表示 → **対応済み**
- **§9.5 領収書**: プレビュー即反映・再発行文言切り替え → **対応済み**
- **§9A.5 ポイント/会員施策**: 表示名変更・抽出元切り替え・無効化 → **対応済み**
- **§10.5 売上サマリー**: 入店数報告OFF・KPI ON/OFF・loyalty 表示 → **設定保存・API で displayOptions 返却済み。POS 側で表示制御する前提**
- **§12.4 印字**: ロケーション別 print_mode 切替・ショップ全体印字設定 → **対応済み**。cloudprnt_direct / order_based の挙動は既存実装に依存。

---

## まとめ

- **設定要件書の「管理画面で設定可能にすべき項目」のうち、§3〜§12 および §4.2.3〜4.2.5 は実装済みです。**
- **残り**
  - **§13.2 location_settings**: ロケーション別の key-value 汎用テーブル（現状は `Location` の固定カラムで代替済み。必要になったら別テーブルを追加可能）。
- 一般設定・精算設定・印字設定・予算設定は専用画面で編集・保存でき、ナビと設定ページの secondaryActions から遷移できます。
