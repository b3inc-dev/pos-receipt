# Shopify POS向け 日本商業施設対応アプリ 要件書

## 0. 文書の目的
本書は、Shopify POS向けに提供する販売用アプリの要件を、実装者がそのまま設計・開発に着手できる粒度で定義することを目的とする。

本書は特に以下を前提とする。

- 実装は Cursor を用いて進める
- Shopify POS Extension / Admin App / Backend / App DB を用いて構築する
- 日本の商業施設運用を想定し、Shopify POS標準では不足する業務を補完する
- CloudPRNT対応プリンタと非対応プリンタの両方に対応する
- **公開用（App Store 販売）と自社用（カスタムアプリ）の2種デプロイ**を同一コードベースでサポートする（POS Stock / Location Stock と同様の構成）

---

## 0.1 公開用・自社用の2種実装（配布形態）

本アプリは、POS Stock（stock-transfer-pos）および Location Stock（location-stock-indicator）と同様に、**公開用**と**自社用**の2つの配布形態を同一コードベースで扱う。

### 0.1.1 役割の違い

| 項目 | 公開用 | 自社用 |
|------|--------|--------|
| **用途** | App Store 等で一般販売 | 自社店舗・グループ向けカスタムアプリ |
| **Shopify アプリ** | 公開用パートナーアプリ（例: POS Receipt） | 自社用パートナーアプリ（例: POS Receipt - 自社） |
| **設定ファイル** | `shopify.app.public.toml` | `shopify.app.toml` |
| **バックエンド URL** | 公開用ホスティング（例: pos-receipt.onrender.com） | 自社用ホスティング（例: pos-receipt-inhouse.onrender.com） |
| **課金・プラン** | スタンダード / プロの Billing API 適用 | プラン制限なし（全機能 Pro 相当）または自社ルール |

### 0.1.2 実装方針

- **POS 拡張が呼ぶ API のベース URL**: ビルド時に「公開用」「自社用」のどちらのバックエンドを指すかを切り替える。  
  - **POS Stock 方式**: `extensions/common/appUrl.js` のような共通モジュールで `APP_MODE = "public" | "inhouse"` を定義し、各 POS 拡張は `getAppUrl()` でベース URL を取得する。  
  - 公開用デプロイ時は `APP_MODE = "public"`、自社用デプロイ時は `APP_MODE = "inhouse"` にした状態で拡張をビルド・デプロイする。
- **バックエンドの配布判定**: 自社用の Render（またはホスティング）には環境変数 **`APP_DISTRIBUTION=inhouse`** を設定する。  
  - このとき、プラン取得をスキップし「全機能利用可能」として扱う（Location Stock と同様）。  
  - 公開用では未設定（または `public`）とし、Billing API でスタンダード / プロを判定する。
- **デプロイ手順**:  
  - 公開用: `APP_MODE=public` でビルド → 公開用 toml で `shopify app deploy`。  
  - 自社用: `APP_MODE=inhouse` でビルド → 自社用 toml で `shopify app deploy`。  
  - 切り替え用に `scripts/set-app-mode.js` と `deploy:public` / `deploy:inhouse` の npm スクリプトを用意することを推奨する（POS Stock 参照: `docs/DEPLOY_PUBLIC_AND_INHOUSE.md`）。

### 0.1.3 共通コードで揃えるもの

- 機能仕様・DB スキーマ・API 仕様は**公開用・自社用で同一**とする。
- 違いが出るのは次のみとする: (1) ベース URL（POS 拡張）、(2) プラン判定ロジック（自社用は `APP_DISTRIBUTION=inhouse` で全機能）、(3) 使用する toml・デプロイ先。

---

## 1. アプリ概要

### 1.1 アプリの提供価値
本アプリは、Shopify POSを利用する日本の商業施設出店事業者向けに、以下の不足機能を提供する。

- 商業施設提出用の精算レシート出力
- Shopify POS標準では実現しづらい特殊返金・返金手段変更
- 編集可能な領収書発行
- 全店舗横断の売上サマリーと予算・入店数管理

### 1.2 想定利用者
- 店舗スタッフ
- 店長
- SV / 本部担当

### 1.3 想定利用シーン
- 閉店時の精算業務
- 返品返金時の例外処理
- 商品券釣有り差額の後処理
- 会計後の領収書発行・再発行
- 日別 / 期間別の売上進捗確認
- 入店数報告

---

## 2. タイル構成

POSタイルは以下の4つとする。

1. 精算
2. 特殊返金・商品券調整
3. 領収書
4. 売上サマリー

### 2.1 タイル別役割

#### 精算
- POSログイン中ロケーションを対象に精算処理を行う
- 商業施設向け精算レシートを出力する
- 点検レシートも発行できる

#### 特殊返金・商品券調整
- 取引を選択し、返金手段変更や商品券釣有り差額の後処理を行う

#### 領収書
- 取引を選択し、領収書を発行 / 再発行する

#### 売上サマリー
- 全ロケーション横断で売上、予算、KPIを閲覧する
- 管理画面設定で有効な場合のみ、サマリー画面内に入店数報告UIを表示する

---

## 3. プラン構成

### 3.1 スタンダードプラン
含む機能:
- 精算
- 特殊返金・商品券調整
- 領収書

### 3.2 プロプラン
含む機能:
- スタンダードプランの全機能
- 売上サマリー
- 売上サマリー内の入店数報告機能
- 予算管理

---

## 4. データの正本方針

### 4.1 Shopifyを正本とするもの
- 注文データ
- 返金データ
- トランザクション
- ロケーション
- 顧客
- ギフトカード

### 4.2 アプリDBを正本とするもの
- 特殊返金イベント
- 商品券調整イベント
- 領収書発行履歴
- 入店数
- 予算
- 売上サマリー用キャッシュ
- 精算実行履歴
- 点検レシート発行履歴

### 4.3 Shopifyメタフィールドの役割
- 表示互換
- 監査補助
- 注文に紐づく補助情報保持

注意: 販売用アプリでは、独自業務ロジックの正本を Shopify メタフィールドのみに依存しないこと。

---

## 5. 導線設計

### 5.1 取引選択前提の機能
以下の機能は「対象取引の選択」を前提とする。

- 特殊返金・商品券調整
- 領収書

### 5.2 起動方法
各機能は以下の2経路で起動できること。

#### A. タイル起動
- POSホームタイルから機能を起動
- 取引一覧画面を表示
- 検索 / 絞り込み / 選択を行う

#### B. 取引詳細画面起動
- POS本体の取引詳細画面から機能を直接起動
- 現在開いている取引を対象として処理を開始する

### 5.3 取引検索要件
検索・絞り込み条件として最低限以下をサポートする。

- 注文番号
- 顧客名
- 日付
- ロケーション

MVPでは部分一致検索 + 日付絞り込み + ロケーション絞り込みを実装対象とする。

---

## 6. 機能要件: 精算

### 6.1 目的
POSログイン中ロケーションの売上を集計し、日本の商業施設向け精算レシートを生成・出力する。

### 6.2 対象ロケーション
- POSログイン中のロケーションのみを対象とする
- ユーザーが精算画面内で他ロケーションを自由選択する仕様にはしない

### 6.3 処理対象日
- 今日
- 指定日

### 6.4 集計項目
最低限以下を出力・保存する。

- 対象期間
- 対象ロケーション
- 総売上
- 純売上
- 消費税
- 割引
- VIPポイント利用額
- 売上件数
- 返金件数
- 点数
- 支払方法別内訳
- 商品券釣有り差額（必要時）

### 6.5 商品券釣有り差額
商品券釣有り差額は精算エンジンで扱う。

優先順位:
1. 特殊返金・商品券調整機能で登録された明示的な商品券調整イベント
2. 会計時に記録された商品券関連データ
3. 注文メモ / 注文補助情報からの推定
4. 情報なしの場合は差額なしとして扱う

### 6.6 点検レシート
- 精算と別メニューで、精算と同じレイアウトの点検レシートを発行できること
- 点検レシートは 0 円または点検用値で出力できること
- 0点検対象店舗設定は不要とする

### 6.7 印字方式
印字方式は両対応必須とする。

#### A. CloudPRNT対応
- 集計後、直接印字する
- 精算注文は作成しない

#### B. CloudPRNT非対応
- 印字用の精算注文を作成する
- 既存の注文レシート導線を用いて印字する

### 6.8 精算注文の扱い
- CloudPRNT対応時は精算注文を作成しない
- CloudPRNT非対応時のみ精算注文を作成する

### 6.9 保存先
- 正本はアプリDBに保存する
- 必要に応じて Shopify 注文メタフィールドにも要約保存する

### 6.10 必要な再処理
- 最新精算の再集計
- 再印字
- 過去日の再実行

---

## 7. 機能要件: 特殊返金・商品券調整

### 7.1 目的
Shopify POS標準では扱いにくい返金手段変更や商品券釣有り差額の後処理を、対象取引に紐づけて記録し、精算へ反映できるようにする。

### 7.2 対象取引
- 取引選択前提とする
- タイルから検索・選択可能
- 取引詳細画面から直接起動可能

### 7.3 イベント種別
イベントは最低限以下の種別で管理する。

- `cash_refund`
- `payment_method_override`
- `voucher_change_adjustment`
- `receipt_cash_adjustment`

### 7.4 イベント管理方針
イベント種別は分けて保持すること。理由:
- 追跡性向上
- 後からの分析容易化
- 精算反映ルールの明確化

### 7.5 イベント共通項目
最低限以下を保持する。

- event_id
- event_type
- source_order_id
- source_order_name
- location_id
- location_name
- amount
- currency
- note
- created_at
- created_by
- status

### 7.6 event_type ごとの追加項目

#### cash_refund
- original_payment_method
- actual_refund_method = cash

#### payment_method_override
- original_payment_method
- actual_refund_method

#### voucher_change_adjustment
- voucher_face_value
- voucher_applied_amount
- voucher_change_amount

#### receipt_cash_adjustment
- method
- adjust_kind (`undo` / `extra`)

### 7.7 処理内容

#### 特殊返金
- 元の決済手段とは異なる返金手段を登録できる
- 返金結果を精算に反映できる

#### 商品券調整
- 商品券額面
- 売上充当額
- 釣り銭額
を後から登録できる

### 7.8 UI要件
画面構成例:
1. 取引検索一覧
2. 取引選択
3. 特殊返金 or 商品券調整の選択
4. 入力フォーム
5. 確認 / 実行

### 7.9 精算反映
精算時、特殊返金・商品券調整イベントを読み込んで、売上 / 返金 / 商品券差額に反映すること。

---

## 8. 機能要件: 領収書

### 8.1 目的
対象取引を選択し、標準機能では不足する日本向け領収書を発行・再発行する。

### 8.2 対象取引
- 取引選択前提とする
- タイルから検索・選択可能
- 取引詳細画面から直接起動可能

### 8.3 テンプレート
- テンプレートは 1 つ固定とする
- 管理画面で編集可能とする
- UIプレビューを見ながら編集できることを理想とする

### 8.4 編集項目
最低限以下を編集可能とする。

- ロゴ
- 発行者情報
- 宛名
- 但し書き
- 日付表示位置
- 金額表示
- 注文番号 / 取引番号表示

### 8.5 発行機能
- 発行
- 再発行
- 発行履歴保存

### 8.6 保存項目
- receipt_id
- order_id
- order_name
- recipient_name
- proviso
- template_version
- created_at
- created_by
- reissued_flag

---

## 9. 機能要件: 売上サマリー

### 9.1 目的
全ロケーション横断で売上状況、予算、KPIを日付指定・期間指定で確認する。

### 9.2 プラン
- プロプラン機能とする

### 9.3 表示単位
- 単日
- 期間指定
- 月次進捗

### 9.4 表示対象
- 全ロケーション
- 実店舗合計
- 総合計

### 9.5 表示項目
最低限以下を対象とする。

#### 日次
- 予算
- 実績
- 予算比
- 客数
- 入店数
- 購買率
- 客単価
- セット率
- 点数
- 一品単価

#### 期間 / 月次
- 月予算
- 月実績
- 達成率
- 遂行予算（当日）
- 遂行率（当日）
- 遂行予算（前日まで）
- 遂行率（前日まで）

### 9.6 日付と期間指定
MVP から以下を含める。
- 日付指定
- 期間指定

### 9.7 入店数報告
入店数報告は売上サマリー内に含める。

条件:
- 管理画面で `footfall_reporting_enabled` が ON の場合のみ表示する
- OFF の場合はUIを表示しない

機能:
- 対象ロケーションに対して入店数を登録できる
- 登録後、サマリー表示に即時反映する

### 9.8 予算管理
- 管理画面から設定する
- CSVテンプレートから一括登録できる
- 手動編集も可能とする

### 9.9 キャッシュ方針
売上サマリーはキャッシュ前提とする。

- 当日分: 短周期更新キャッシュ
- 過去分: アーカイブキャッシュ
- 月次: 月次キャッシュ

---

## 10. 管理画面要件

### 10.1 設定カテゴリ
最低限以下を持つ。

#### A. プリンタ / 印字設定
- ロケーションごとの印字方式
  - CloudPRNT direct
  - order-based print

#### B. 領収書設定
- テンプレート編集
- プレビュー

#### C. 売上サマリー設定
- 売上サマリー有効化
- 入店数報告有効化
- 予算CSVアップロード
- 予算手動編集
- 表示対象ロケーション制御

#### D. 商品券 / 特殊返金設定
- イベント種別の有効可否
- 将来用の補正ルール設定領域

### 10.2 管理画面UI方針
- 可能な限りプレビュー型
- コード編集ではなくフォーム / ビジュアル編集中心

---

## 11. データモデル（MVP）

### 11.1 settlements
- id
- shop_id
- location_id
- location_name
- target_date
- period_label
- total
- net_sales
- tax
- discounts
- vip_points_used
- order_count
- refund_count
- item_count
- voucher_change_amount
- payment_sections_json
- print_mode
- created_at
- updated_at
- printed_at
- source_order_id_nullable

### 11.2 special_refund_events
- id
- shop_id
- event_type
- source_order_id
- source_order_name
- location_id
- location_name
- original_payment_method_nullable
- actual_refund_method_nullable
- amount
- voucher_face_value_nullable
- voucher_applied_amount_nullable
- voucher_change_amount_nullable
- adjust_kind_nullable
- note
- created_by
- created_at
- status

### 11.3 receipt_issues
- id
- shop_id
- order_id
- order_name
- location_id
- recipient_name
- proviso
- amount
- template_version
- is_reissue
- created_by
- created_at

### 11.4 footfall_reports
- id
- shop_id
- location_id
- location_name
- target_date
- visitors
- created_by
- created_at
- updated_at

### 11.5 budgets
- id
- shop_id
- location_id
- target_date
- budget_amount
- created_at
- updated_at

### 11.6 sales_summary_cache_daily
- id
- shop_id
- location_id
- target_date
- actual
- orders
- items
- visitors_nullable
- conv_nullable
- atv_nullable
- set_rate_nullable
- unit_nullable
- budget_nullable
- budget_ratio_nullable
- updated_at

### 11.7 sales_summary_cache_period
- id
- shop_id
- location_id
- period_key
- month_budget
- month_actual
- month_prog_today
- month_prog_prev
- updated_at

---

## 12. API方針

### 12.1 Backend責務
Backend は以下を担う。

- Shopify注文検索
- Shopify売上集計取得
- 特殊返金イベント登録
- 商品券調整イベント登録
- 領収書データ生成
- 精算データ生成
- キャッシュ生成

### 12.2 API群（例）

#### Settlement APIs
- `POST /api/settlements/preview`
- `POST /api/settlements/create`
- `POST /api/settlements/recalculate`
- `POST /api/settlements/print`

#### Orders Search APIs
- `GET /api/orders/search`
- `GET /api/orders/:id`

#### Special Refund APIs
- `POST /api/special-refunds`
- `GET /api/special-refunds?orderId=...`
- `POST /api/voucher-adjustments`

#### Receipt APIs
- `POST /api/receipts/preview`
- `POST /api/receipts/issue`
- `GET /api/receipts/history?orderId=...`

#### Sales Summary APIs
- `GET /api/sales-summary/daily`
- `GET /api/sales-summary/period`
- `POST /api/footfall`
- `POST /api/budgets/import`
- `POST /api/budgets/upsert`

---

## 13. 印字方針

### 13.1 精算
- CloudPRNT対応: 直接印字
- 非対応: 精算注文経由で印字

### 13.2 領収書
- アプリ側レンダリング + 印字
- 詳細なプリント制御は店舗設定で切り替え可能な設計にする

### 13.3 点検レシート
- 精算レイアウトと同系統で出力

---

## 14. 非機能要件

### 14.1 パフォーマンス
- 売上サマリー画面はキャッシュ前提で 3 秒以内の初期表示を目指す
- 取引検索はページング必須

### 14.2 信頼性
- 再実行可能であること
- 二重登録を防止すること
- 特殊返金 / 商品券調整はイベント単位で取消または無効化できる設計にすること

### 14.3 監査補助
権限分離は MVP では不要だが、最低限以下は保持する。
- created_by
- created_at
- updated_at

### 14.4 国際化
MVP は日本語固定でよい。

---

## 15. MVP範囲

### 15.1 MVPに含む
- POSタイル4つ
- 取引検索一覧 + 取引詳細起動
- 精算（CloudPRNT direct / order-based 両対応）
- 点検レシート
- 特殊返金イベント登録
- 商品券後処理イベント登録
- 領収書発行 / 再発行
- 領収書テンプレート1つ + 管理画面編集
- 売上サマリー（日付指定 / 期間指定）
- 予算設定
- 予算CSV登録
- 売上サマリー内の入店数報告（管理画面ON時のみ）
- アプリDB保存

### 15.2 MVPで後回しにしてよいもの
- 複数領収書テンプレート
- 権限分離UI
- 高度な分析グラフ
- 通知 / アラート
- 取引検索の高度フィルタ
- 店舗別の複雑な帳票分岐

---

## 16. 実装メモ（Cursor向け）

### 16.1 まず作るべきモジュール
1. Orders Search Module
2. Settlement Engine
3. Special Refund Engine
4. Receipt Engine
5. Sales Summary Engine
6. Admin Settings Module
7. Print Adapter Module

### 16.2 先に固定してよい前提
- 権限分離は実装しない
- 領収書テンプレートは1種類
- CloudPRNT対応時は精算注文を作成しない
- 入店数報告は売上サマリー内に内包する
- 商品券釣有りは精算で自動反映しつつ、後処理イベントも持てる

### 16.3 実装優先順
1. データモデル定義
2. Shopify注文検索API
3. 特殊返金 / 商品券調整API
4. 精算プレビュー / 保存 / 印字
5. 領収書プレビュー / 発行
6. 売上サマリー + 予算 + 入店数
7. 管理画面設定

### 16.4 公開用・自社用の考慮
- **Phase 1（App scaffold）** の段階で、POS 拡張用の共通 `appUrl.js`（または同等）を用意し、`APP_MODE` でベース URL を切り替えられるようにする。
- バックエンドでは、起動時に `APP_DISTRIBUTION` 環境変数を読み、`inhouse` のときはプラン制限をかけず全機能を許可する分岐を入れる。
- デプロイ用に `shopify.app.public.toml`（公開用）と `shopify.app.toml`（自社用）、および `deploy:public` / `deploy:inhouse` スクリプトを早めに整備すると、以降の実装が楽になる。

---

## 17. 最終決定事項一覧

- **公開用・自社用の2種デプロイ**を同一コードベースでサポートする（APP_MODE / APP_DISTRIBUTION、2 toml、deploy スクリプト）。
- POSタイルは 4 つ
- 特殊返金・商品券調整・領収書は取引選択前提
- タイル起動と取引詳細画面起動の両方に対応
- 元データは Shopify、独自業務データはアプリDB正本
- 権限分離は MVP 不要
- 料金プランはスタンダード / プロ
- CloudPRNT直印字と注文経由印字は両対応必須
- CloudPRNT時は精算注文を作らない
- 特殊返金イベント種別は4種類で分ける
- 領収書テンプレートは1つ固定、管理画面編集
- 売上サマリーは日付指定・期間指定を最初から含む
- 予算は管理画面設定 + CSVインポート対応
- 入店数報告は売上サマリー内に表示し、管理画面設定ON時のみ有効

---

## 18. Cursor向け 実装分解（Epics / Stories / Tasks）

本章は、Cursor で段階的に実装を進めるための分解である。
実装順・依存関係・受け入れ条件を明示する。

### 18.1 Epic一覧

#### Epic A. 基盤構築
目的:
- Shopifyアプリとしての基本構成を作る
- Backend / DB / Admin / POS Extension の土台を作る

成果物:
- Shopify App scaffold
- DB接続
- 認証
- App settings framework
- 共通 UI / API / logging 基盤

#### Epic B. 注文検索・取引選択基盤
目的:
- 特殊返金・商品券調整・領収書の共通導線となる取引検索機能を作る

成果物:
- 注文検索API
- POS用取引一覧UI
- 取引詳細画面起動導線

#### Epic C. 精算
目的:
- 商業施設向け精算レシート生成・出力機能を作る

成果物:
- Settlement Engine
- 印字分岐（CloudPRNT / order-based）
- 点検レシート
- 精算履歴

#### Epic D. 特殊返金・商品券調整
目的:
- 返金手段変更や商品券後処理イベントを登録し、精算へ反映する

成果物:
- 特殊返金イベント登録UI
- 商品券調整UI
- イベント保存API
- 精算反映ロジック

#### Epic E. 領収書
目的:
- 領収書の発行・再発行とテンプレート編集を実装する

成果物:
- 領収書プレビュー
- 発行 / 再発行
- 履歴保存
- 管理画面テンプレート編集

#### Epic F. 売上サマリー
目的:
- 日付指定 / 期間指定の売上サマリーを表示し、予算・入店数を扱う

成果物:
- 売上サマリーAPI
- サマリー画面
- 予算管理
- 入店数報告
- キャッシュ更新ジョブ

#### Epic G. プラン制御
目的:
- スタンダード / プロの機能制御を入れる

成果物:
- App subscription
- Feature flags
- プランごとの表示 / 非表示制御

#### Epic H. 品質・運用
目的:
- ログ・エラーハンドリング・再実行・監査補助を整える

成果物:
- audit columns
- retry-safe APIs
- diagnostics
- seed data / fixtures

---

## 19. 画面一覧

### 19.1 POSホームタイル

#### POS Tile: 精算
主なアクション:
- 今日の精算
- 指定日精算
- 点検レシート
- 再印字

#### POS Tile: 特殊返金・商品券調整
主なアクション:
- 取引検索
- 特殊返金登録
- 商品券調整登録

#### POS Tile: 領収書
主なアクション:
- 取引検索
- 領収書発行
- 再発行

#### POS Tile: 売上サマリー
主なアクション:
- 日付指定
- 期間指定
- ロケーション別表示
- 入店数報告（設定ON時のみ）

### 19.2 POS注文詳細画面アクション

#### Order Action: 特殊返金・商品券調整
- 現在の取引を対象として起動

#### Order Action: 領収書
- 現在の取引を対象として起動

### 19.3 管理画面

#### Admin Page: 一般設定
- プラン状態
- ロケーションごとの印字方式
- feature flags

#### Admin Page: 領収書テンプレート
- レイアウト編集
- プレビュー

#### Admin Page: 売上サマリー設定
- サマリー有効化
- 入店数報告有効化
- 対象店舗設定

#### Admin Page: 予算管理
- 予算一覧
- 手動編集
- CSVインポート

#### Admin Page: 精算履歴
- 精算履歴一覧
- ステータス
- 再印字導線

#### Admin Page: 領収書履歴
- 発行履歴
- 再発行履歴

#### Admin Page: 特殊返金履歴
- イベント一覧
- 取引別確認

---

## 20. DBスキーマ詳細（MVP）

以下は SQL / Prisma / Drizzle 等へ落とし込み可能な論理スキーマである。

### 20.1 shops
- id
- shopify_shop_gid
- shop_domain
- plan_code
- created_at
- updated_at

### 20.2 locations
- id
- shop_id
- shopify_location_gid
- name
- code_nullable
- print_mode (`cloudprnt_direct` / `order_based`)
- sales_summary_enabled
- footfall_reporting_enabled
- created_at
- updated_at

### 20.3 app_settings
- id
- shop_id
- key
- value_json
- created_at
- updated_at

### 20.4 settlements
- id
- shop_id
- location_id
- source_order_id_nullable
- source_order_name_nullable
- target_date
- period_label
- currency
- total
- net_sales
- tax
- discounts
- vip_points_used
- refund_total
- order_count
- refund_count
- item_count
- voucher_change_amount
- payment_sections_json
- print_mode
- printed_at_nullable
- status (`draft` / `completed` / `printed` / `failed`)
- created_at
- updated_at

Indexes:
- unique(shop_id, location_id, target_date, status?) は要件次第
- index(shop_id, target_date)
- index(location_id, target_date)

### 20.5 special_refund_events
- id
- shop_id
- source_order_id
- source_order_name
- location_id
- event_type
- original_payment_method_nullable
- actual_refund_method_nullable
- amount
- currency
- voucher_face_value_nullable
- voucher_applied_amount_nullable
- voucher_change_amount_nullable
- adjust_kind_nullable
- note_nullable
- created_by_nullable
- status (`active` / `voided`)
- created_at
- updated_at

Indexes:
- index(shop_id, source_order_id)
- index(location_id, created_at)
- index(event_type, created_at)

### 20.6 receipt_templates
- id
- shop_id
- name
- is_active
- template_json
- version
- created_at
- updated_at

MVPでは1レコードのみ active を想定

### 20.7 receipt_issues
- id
- shop_id
- order_id
- order_name
- location_id
- recipient_name
- proviso
- amount
- currency
- template_id
- template_version
- is_reissue
- created_by_nullable
- created_at

Indexes:
- index(shop_id, order_id)
- index(location_id, created_at)

### 20.8 budgets
- id
- shop_id
- location_id
- target_date
- amount
- created_at
- updated_at

Indexes:
- unique(shop_id, location_id, target_date)

### 20.9 footfall_reports
- id
- shop_id
- location_id
- target_date
- visitors
- created_by_nullable
- created_at
- updated_at

Indexes:
- unique(shop_id, location_id, target_date)

### 20.10 sales_summary_cache_daily
- id
- shop_id
- location_id
- target_date
- actual
- orders
- items
- visitors_nullable
- conv_nullable
- atv_nullable
- set_rate_nullable
- unit_nullable
- budget_nullable
- budget_ratio_nullable
- updated_at

Indexes:
- unique(shop_id, location_id, target_date)

### 20.11 sales_summary_cache_period
- id
- shop_id
- location_id
- period_type (`month` / `custom_range`)
- period_key
- start_date
- end_date
- budget_total
- actual_total
- progress_budget_today_nullable
- progress_budget_prev_nullable
- updated_at

Indexes:
- unique(shop_id, location_id, period_type, period_key)

---

## 21. API詳細仕様

本章は REST 例で記載する。GraphQL で実装してもよいが、意味は同じとする。

### 21.1 認証共通
- Shopify session / app auth を前提とする
- POS extension からの呼び出し時は app proxy ではなく backend API を想定
- shop context は session から解決する

### 21.2 注文検索API

#### GET /api/orders/search
Query:
- q: string nullable
- locationId: string nullable
- dateFrom: YYYY-MM-DD nullable
- dateTo: YYYY-MM-DD nullable
- cursor: string nullable
- limit: number default 20

Response:
- items: array
  - orderId
  - orderName
  - customerName
  - locationId
  - locationName
  - totalPrice
  - currency
  - createdAt
- nextCursor nullable

Acceptance:
- 注文番号部分一致で検索できる
- 顧客名部分一致で検索できる
- 日付範囲で絞れる
- ページングできる

#### GET /api/orders/:orderId
Response:
- order core fields
- transactions
- refunds
- customer
- location
- line items summary

### 21.3 精算API

#### POST /api/settlements/preview
Body:
- locationId
- targetDate
- printMode

Response:
- settlement preview DTO
  - totals
  - payment sections
  - voucher change
  - applied special refund events
  - applied voucher adjustments

#### POST /api/settlements/create
Body:
- locationId
- targetDate
- printMode
- isInspection boolean default false

Response:
- settlementId
- printable payload or order-based print reference
- created resources

Rules:
- cloudprnt_direct: Shopify精算注文を作らない
- order_based: Shopify精算注文を作る

#### POST /api/settlements/recalculate
Body:
- settlementId or (locationId + targetDate)

Response:
- recalculated settlement DTO

#### POST /api/settlements/print
Body:
- settlementId

Response:
- print result

### 21.4 特殊返金API

#### POST /api/special-refunds
Body:
- sourceOrderId
- eventType
- amount
- originalPaymentMethod nullable
- actualRefundMethod nullable
- note nullable

Allowed eventType:
- cash_refund
- payment_method_override
- receipt_cash_adjustment

Response:
- event record

#### POST /api/voucher-adjustments
Body:
- sourceOrderId
- voucherFaceValue
- voucherAppliedAmount
- voucherChangeAmount
- note nullable

Response:
- event record with eventType = voucher_change_adjustment

#### GET /api/special-refunds
Query:
- sourceOrderId

Response:
- items[]

#### POST /api/special-refunds/:id/void
Body: none
Response:
- updated event status

### 21.5 領収書API

#### POST /api/receipts/preview
Body:
- orderId
- recipientName
- proviso

Response:
- receipt HTML / printable model

#### POST /api/receipts/issue
Body:
- orderId
- recipientName
- proviso
- isReissue boolean default false

Response:
- receiptIssueId
- printable payload

#### GET /api/receipts/history
Query:
- orderId nullable
- dateFrom nullable
- dateTo nullable

Response:
- items[]

### 21.6 売上サマリーAPI

#### GET /api/sales-summary/daily
Query:
- targetDate
- locationIds[] nullable

Response:
- rows[]
- totals

#### GET /api/sales-summary/period
Query:
- dateFrom
- dateTo
- locationIds[] nullable

Response:
- rows[]
- totals
- progress metrics

#### POST /api/footfall
Body:
- locationId
- targetDate
- visitors

Response:
- saved row
- recomputed summary row

Condition:
- location or shop setting `footfall_reporting_enabled = true` のときのみ許可

#### POST /api/budgets/import
Body:
- CSV file

Response:
- inserted count
- updated count
- errors[]

#### POST /api/budgets/upsert
Body:
- locationId
- targetDate
- amount

Response:
- budget row

### 21.7 管理画面設定API

#### GET /api/settings
#### POST /api/settings

Settings keys example:
- plan_code
- receipt_template
- footfall_reporting_enabled
- sales_summary_enabled
- location_print_modes

---

## 22. DTO定義（推奨）

### 22.1 OrderListItemDTO
- orderId
- orderName
- customerName
- locationId
- locationName
- total
- currency
- createdAt

### 22.2 SettlementPreviewDTO
- locationId
- locationName
- targetDate
- total
- netSales
- tax
- refundTotal
- discounts
- vipPointsUsed
- orderCount
- refundCount
- itemCount
- voucherChangeAmount
- paymentSections[]
- appliedSpecialRefundEvents[]
- appliedVoucherAdjustments[]

### 22.3 PaymentSectionDTO
- label
- net
- refund
- txCount
- refundCount

### 22.4 SpecialRefundEventDTO
- id
- eventType
- sourceOrderId
- sourceOrderName
- amount
- note
- createdAt
- status

### 22.5 ReceiptPreviewDTO
- orderId
- recipientName
- proviso
- amount
- templateVersion
- html

### 22.6 DailySalesSummaryRowDTO
- locationId
- locationName
- budget
- actual
- budgetRatio
- orders
- visitors
- conv
- atv
- setRate
- items
- unit

---

## 23. POS画面仕様詳細

### 23.1 精算タイル画面

#### Step 1: 初期表示
- ログイン中 location 自動取得
- 対象日 default = 今日
- 印字方式表示

#### Step 2: プレビュー
表示:
- total
- net sales
- tax
- voucher change
- payment sections

#### Step 3: 実行
ボタン:
- 精算レシート発行
- 点検レシート発行
- 再集計

Acceptance:
- CloudPRNT直印字店舗で直接印字できる
- 非対応店舗では注文経由導線に遷移できる

### 23.2 特殊返金・商品券調整タイル画面

#### Step 1: 取引検索一覧
- search input
- filters
- list items

#### Step 2: 処理種別選択
- 特殊返金
- 商品券調整

#### Step 3A: 特殊返金フォーム
Fields:
- eventType
- amount
- original payment method
- actual refund method
- note

#### Step 3B: 商品券調整フォーム
Fields:
- voucher face value
- voucher applied amount
- voucher change amount
- note

Acceptance:
- 保存後、同一取引のイベント一覧に表示される
- 精算プレビューに反映される

### 23.3 領収書タイル画面

#### Step 1: 取引検索一覧
#### Step 2: 領収書入力
Fields:
- recipientName
- proviso

#### Step 3: プレビュー
#### Step 4: 発行

Acceptance:
- 発行履歴が保存される
- 同一取引で再発行できる

### 23.4 売上サマリータイル画面

#### Filters
- 日付指定
- 期間指定

#### Display
- location cards or list
- totals
- daily and period metrics

#### Footfall UI
条件:
- shop or location setting enabled

表示内容:
- 入店数入力欄
- 保存ボタン
- 保存後再描画

Acceptance:
- 日付指定で表示が更新される
- 期間指定で表示が更新される
- 入店数保存後に即時反映する

---

## 24. 管理画面仕様詳細

### 24.1 領収書テンプレート編集画面
Fields:
- company name
- address
- phone
- logo
- default proviso
- layout json or visual blocks

Preview:
- live preview pane

Acceptance:
- 保存後、次回発行プレビューに反映される

### 24.2 予算管理画面
Actions:
- CSV template download
- CSV upload
- row edit
- row delete
- location/date filter

Acceptance:
- CSV取込時に upsert できる
- エラー行を返せる

### 24.3 一般設定画面
Fields:
- feature flags
- location print mode mapping
- footfall reporting enabled

---

## 25. バッチ / ジョブ仕様

### 25.1 Daily Sales Cache Refresh Job
Frequency:
- 5分ごと（営業時間内）

Responsibility:
- 当日分サマリー再集計
- `sales_summary_cache_daily` 更新

### 25.2 Daily Archive Job
Frequency:
- 毎日深夜

Responsibility:
- 前日分を確定値として保存

### 25.3 Monthly Cache Job
Frequency:
- 毎日深夜

Responsibility:
- 月次進捗キャッシュ更新

### 25.4 Optional Rebuild Job
Responsibility:
- 期間指定でキャッシュ再構築

---

## 26. Cursor向け 実装タスク一覧

### Phase 1. App scaffold
- Shopify app scaffold 作成
- Admin app route 作成
- POS extension 4タイル作成
- DB migration 初期化
- env / config 整備
- **公開用・自社用**: 共通 `appUrl.js`（APP_MODE）の用意、`shopify.app.public.toml` / `shopify.app.toml` の2本立て、`deploy:public` / `deploy:inhouse` 用スクリプトの用意

### Phase 2. Common infra
- logger
- error handler
- shop resolver
- location repository
- feature flag helper
- plan gate helper

### Phase 3. Order search
- orders search service
- search API
- POS order picker UI
- order details launch integration

### Phase 4. Special refunds
- DB table
- create event API
- list events API
- void event API
- POS form UI
- settlement integration

### Phase 5. Receipts
- template table
- preview renderer
- issue API
- history API
- admin editor UI
- POS issue UI

### Phase 6. Settlements
- settlement engine
- preview API
- create API
- print adapter interface
- cloudprnt adapter
- order-based adapter
- POS settlement UI

### Phase 7. Sales summary
- budgets CRUD/import
- footfall CRUD
- daily cache table
- period cache table
- summary APIs
- POS summary UI
- admin budget UI
- jobs

### Phase 8. Billing / plan gates
- standard/pro mapping
- UI hiding/showing
- API guard

### Phase 9. QA / polish
- fixtures
- seed data
- empty state
- retry state
- diagnostics page

---

## 27. 各Epicの受け入れ条件

### Epic A 受け入れ条件
- アプリが開発ストアへインストールできる
- Admin と POS extension の両方が起動する
- DB migration が通る

### Epic B 受け入れ条件
- 注文検索ができる
- タイル経由でも取引詳細経由でも対象注文を選べる

### Epic C 受け入れ条件
- 精算プレビューが出る
- 印字方式に応じて処理が分岐する
- 点検レシートが発行できる

### Epic D 受け入れ条件
- 特殊返金イベントが保存される
- 商品券調整イベントが保存される
- 精算へ反映される

### Epic E 受け入れ条件
- 領収書プレビューできる
- 発行 / 再発行できる
- 管理画面編集内容が反映される

### Epic F 受け入れ条件
- 日付指定 / 期間指定で売上サマリーが表示される
- 予算が反映される
- 入店数報告が設定ON時のみ使える

### Epic G 受け入れ条件
- スタンダードでは売上サマリーが使えない
- プロでは使える

### Epic H 受け入れ条件
- 主要操作にログが残る
- 失敗時の再試行ができる
- 主要テーブルに audit columns がある

---

## 28. 実装で後回しにしない注意点

- Shopify order data と app DB event data を混同しないこと
- CloudPRNT時に精算注文を作らないこと
- 商品券釣有りは自動推定だけに依存しないこと
- 領収書テンプレートは1つでも version を持つこと
- 取引選択UIは特殊返金・領収書で共通化すること
- 売上サマリーはキャッシュ前提で作ること

---

## 29. Cursorへの初回実装指示テンプレート

以下の順で Cursor に作業させることを推奨する。

### Prompt 1
この要件書を元に、技術スタック前提のプロジェクト構成案を作成してください。Admin App, POS Extensions, Backend API, DB, Jobs のディレクトリ構成と責務分離を提案してください。

### Prompt 2
この要件書の DB スキーマ章を元に、Prisma schema または SQL migration を生成してください。MVP 範囲のみでよいです。

### Prompt 3
注文検索 API と取引選択 UI を最初に実装してください。POS タイルからの検索と、注文詳細画面からの current order 起動の両方を考慮してください。

### Prompt 4
特殊返金・商品券調整イベントの create/list/void API と POS UI を実装してください。event_type は要件書の4種に対応してください。

### Prompt 5
精算プレビュー API と print adapter interface を実装してください。印字方式は cloudprnt_direct と order_based を切り替えられるようにしてください。

### Prompt 6
領収書テンプレート編集画面、プレビュー API、発行 API、履歴保存を実装してください。テンプレートは1つ固定です。

### Prompt 7
売上サマリー API、予算管理、入店数報告、日次 / 期間キャッシュ、管理画面設定を実装してください。

---

## 30. 実装済み内容（進捗メモ）

本書の実装指示に沿って作業した結果を記録する。日付は完了した時点の目安。

### 30.1 完了した作業

| 項目 | 内容 |
|------|------|
| **Prompt 1** | プロジェクト構成案を作成。`docs/PROJECT_STRUCTURE_PROPOSAL.md` に Admin App / POS Extensions / Backend API / DB / Jobs のディレクトリ構成と責務を記載。 |
| **Prompt 2** | Prisma schema を要件書の DB スキーマ（11章・20章）に基づき作成。`prisma/schema.prisma`、`docs/DB_MIGRATION.md` を整備。 |
| **Phase 1（App scaffold）** | React Router v7 ベースの Shopify App を構築。`app/shopify.server.ts`（認証・PrismaSessionStorage）、`app/db.server.ts`、認証ルート（auth.$, auth.login）、管理画面レイアウト（app.tsx, app._index）、`shopify.app.toml` のスコープ（read_orders, read_locations）を設定。 |
| **公開用・自社用の分離** | `shopify.app.public.toml`（公開用・`https://pos-receipt.onrender.com`）を新規作成。`shopify.app.toml` は自社用（POS Receipt - Ciara）用に整理。`extensions/common/appUrl.js` で `APP_MODE`（public / inhouse）と `getAppUrl()` を定義。 |
| **Prompt 3（注文検索・取引選択）** | 注文検索 API（`GET /api/orders/search`：q, locationId, dateFrom, dateTo, cursor, limit）と注文詳細 API（`GET /api/orders/:orderId`）を実装。POS 共通の `extensions/common/orderPickerApi.js`（searchOrders, getOrder）を用意。POS タイル用モーダル（`extensions/pos-smart-grid/src/Modal.jsx`）で検索・一覧・選択 UI を実装。注文詳細画面から「この取引で開く」で起動する `OrderAction.jsx`（target: pos.order-details.action.menu-item.render）を追加。 |
| **Render・URL 設定** | Render 用の手順を `docs/RENDER_SETUP.md`、`docs/RENDER_DATABASE_URL.md`、`docs/NEXT_STEPS_AFTER_RENDER.md` に記載。公開用の Shopify URL を Render に合わせて `shopify.app.public.toml` に設定（application_url / redirect_urls）。 |
| **Prompt 4（特殊返金・商品券調整）** | Backend: `app/utils/shopResolver.server.ts`、`api.special-refunds.tsx`（GET list / POST create）、`api.special-refunds.$id.void.tsx`（POST void）、`api.voucher-adjustments.tsx`（POST create）を実装。POS 拡張: ソースファイルを4タイル分割構成に整備（`SpecialRefundTile/Modal/OrderAction.jsx`、`SettlementTile/Modal.jsx`、`ReceiptTile/Modal/OrderAction.jsx`、`SalesSummaryTile/Modal.jsx`）。`extensions/common/specialRefundApi.js` を追加。`shopify.extension.toml` は登録済み UID 1本（pos-special-refund）のみ使用し、他3タイルは `shopify app generate extension` で UID 発行後に接続予定（Phase 5–7）。 |
| **バグ修正: Render 502 / Session テーブル未作成** | `prisma/migrations/` が未コミットだったため Render 上で `prisma migrate deploy` が何も実行せず全テーブルが未作成だった。`prisma/migrations/20260310112900_init/migration.sql` をコミット・プッシュして解消。 |
| **バグ修正: POS ビルドエラー（Tile.jsx not found）** | `.shopify/dev-bundle` キャッシュが旧ファイル（`Tile.jsx/Modal.jsx/OrderAction.jsx`）を参照していた。キャッシュ削除 + TOML を登録済み UID 1本に修正して解消。 |
| **Prompt 5（精算）** | Settlement Engine（`app/services/settlementEngine.server.ts`）を実装。API 4本（preview / create / recalculate / print）と `api.locations.tsx` を追加。`extensions/common/settlementApi.js` を追加。`SettlementModal.jsx` を全ステップ実装（main → preview → confirm → done → history）。CloudPRNT直印字 / 注文経由印字（Shopify精算注文作成）の両分岐に対応。点検レシートも同フローで `isInspection=true` で処理。`shopify.extension.toml` に精算タイルエントリを追加（UID は `shopify app generate extension` で取得必要）。 |

### 30.2 主要ファイル一覧（実装済み）

- **Backend**: `app/shopify.server.ts`, `app/db.server.ts`, `app/routes/api.orders.search.tsx`, `app/routes/api.orders.$orderId.tsx`, `app/routes/api.special-refunds.tsx`, `app/routes/api.special-refunds.$id.void.tsx`, `app/routes/api.voucher-adjustments.tsx`, `app/utils/shopResolver.server.ts`
- **精算 Backend**: `app/services/settlementEngine.server.ts`, `app/routes/api.locations.tsx`, `app/routes/api.settlements.preview.tsx`, `app/routes/api.settlements.create.tsx`, `app/routes/api.settlements.recalculate.tsx`, `app/routes/api.settlements.print.tsx`
- **POS 拡張**: `extensions/common/appUrl.js`, `extensions/common/orderPickerApi.js`, `extensions/common/specialRefundApi.js`, `extensions/common/settlementApi.js`
  - 特殊返金（稼働中）: `SpecialRefundTile.jsx`, `SpecialRefundModal.jsx`, `SpecialRefundOrderAction.jsx`
  - 精算（実装済み・UID 取得後に TOML 接続）: `SettlementTile.jsx`, `SettlementModal.jsx`
  - 領収書（スタブ）: `ReceiptTile.jsx`, `ReceiptModal.jsx`, `ReceiptOrderAction.jsx`
  - 売上サマリー（スタブ）: `SalesSummaryTile.jsx`, `SalesSummaryModal.jsx`
- **DB**: `prisma/schema.prisma`, `prisma/migrations/20260310112900_init/migration.sql`
- **設定**: `shopify.app.toml`（自社用）, `shopify.app.public.toml`（公開用）, `extensions/pos-smart-grid/shopify.extension.toml`
- **ドキュメント**: `docs/PROJECT_STRUCTURE_PROPOSAL.md`, `docs/DB_MIGRATION.md`, `docs/PUBLIC_INHOUSE_APP_DEFINITION.md`, `docs/CLI_SETUP_AND_USAGE.md`, `docs/RENDER_SETUP.md`, `docs/NEXT_STEPS_AFTER_RENDER.md` 他

### 30.3 既知の制約・注意事項

- **精算タイルの UID**: `shopify.extension.toml` に精算タイルエントリを追加済みだが、`uid` フィールドは未設定。`shopify app generate extension` を実行して UID を取得し、TOML に追加する必要がある。
- **`.shopify/` キャッシュ**: `shopify app dev` でビルドエラーが出た場合は `.shopify/dev-bundle/` と `extensions/pos-smart-grid/dist/` を削除してから再起動する。
- **精算タイムゾーン**: 特殊返金イベントの日付絞り込みは UTC 基準。JST（UTC+9）では夜9時以降の翌日分が翌営業日に含まれない場合がある（MVP 許容）。

### 30.4 次のステップ

- **精算タイル UID 発行**: `shopify app generate extension` を実行して精算タイルの UID を取得し、`shopify.extension.toml` に追加する。
- **Prompt 6（領収書）**: 領収書テンプレート編集、プレビュー API、発行 API、履歴保存、管理画面編集 UI。
- 上記のあと、Prompt 7（売上サマリー）→ Prompt 8（Billing）の順で実装を進める。

