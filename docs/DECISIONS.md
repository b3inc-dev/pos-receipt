# DECISIONS — 設計判断・負債・未確認

コードと現行 docs から読み取れる判断・負債・未確認の一覧です。新規の仕様推測は含めません。

## 1. 確定している設計判断（コード上の意図）

| ID | 判断 | 根拠 |
|----|------|------|
| D1 | 精算の日次注文取得は GAS 同型（`location_id` + created∪updated∪cancelled）。`source_name:pos` と retailLocation 二次フィルタは付けない | `settlementEngine` コメント 1001–1005 行付近 |
| D2 | 売上サマリー日次の基礎数値は精算プレビューと同一関数で差分ゼロ化 | `salesSummaryEngine.computeAndCacheDailySummary` → `buildSettlementPreview` |
| D3 | 実効 printMode は DB `Location.printMode`。リクエスト body は決定に使わない | `api.settlements.create.tsx` |
| D4 | `cloudprnt_direct` では Shopify 精算注文を作らない | `settlementSyncSettings` + create 分岐 |
| D5 | 精算の冪等キーは `shopId:locationId:targetDate:printMode`。点検は除外 | create ルート |
| D6 | 返金の店舗帰属は設定可能な metafield / Location フラグで制御 | `refundAggregation.server.ts` |
| D7 | VIP は割引コード接頭辞 `VIP-` | `aggregateGasStyleForOrders` |
| D8 | 公開／自社は別 toml・別 Render・APP_MODE | `DEPLOY_PUBLIC_AND_INHOUSE.md` + package scripts |
| D9 | アプリ課金プラン（Lite/Pro）でサマリー系を制限。精算・領収書・特殊返金は全プラン | `planFeatures.server.ts` |
| D10 | 特殊返金の正本は Gift Card ではなく `SpecialRefundEvent` | schema + API + GAS_vs_APP 記載 |

## 2. 古い docs との差分（注意）

| ドキュメント | 記載 | 現行コード |
|--------------|------|------------|
| `LOCATION_AND_SOURCE_VERIFICATION.md` | 精算クエリに `source_name:pos`、retailLocation 二次フィルタ | 精算メインパスでは **どちらも無し**。注文検索には残存 |
| 同・売上サマリー節 | 独自 `shopifyQuery` + filter | 現状は `buildSettlementPreview` 再利用。`fetchSummaryOrders` 等はファイル内に残るが呼び出し無し |
| `GAS_vs_APP_IMPLEMENTATION_GAP.md` 一部「未対応」節 | タイムゾーンや特殊返金未反映など | 冒頭では対応済と更新済みだが、本文の「現在の実装」段落が古いまま残っている箇所あり。**挙動はコードを正** |
| `PROGRESS_SUMMARY.md` | 最終更新 2026-03-12 | その後の返金帰属・Shopify 返金実行等が追加されている |

## 3. 技術的負債・重複・混在

| 項目 | 内容 |
|------|------|
| 決済名称の二重系 | 集計は `gasNormalizeGatewayLabel` のハードコード日本語。表示マスタは `PaymentMethodMaster`。英数字キーのみマスタ差し替え |
| ロケーション ID 正規化の重複 | `extractLocationNumericId` / `normalizeLocationGid` が複数ファイルに存在 |
| 返金オーバーレイ死コード | `getRefundOverlayForDay` / `computeRefundsOnlyForDay` は定義・export されるが、プレビュー本体からの適用は無く、他ファイルからの import も見当たらない |
| 売上サマリー死コード | `SUMMARY_ORDERS_QUERY` / `fetchSummaryOrders` / `filterSummaryOrdersByRetailLocation` が未使用のまま残存 |
| 表示と集計の混在 | payment section の `label` が集計キー由来のまま残るケース（日本語 GAS ラベルはマスタ非適用） |
| 精算設定ラベル未使用 | UI で項目名を変えられても `buildSettlementReceiptText` は固定文言 |
| 点検 UI と実装 | DoneView は点検で Shopify 注文を作らない旨を示しうるが、`order_based` では `syncInspectionOrderLikeGas` を呼びうる |
| customAttributes | 取得するが UI 非表示 |
| レガシー Gift Card | 設定デフォルト／検証用フラグ。API 失敗は握りつぶして続行 |
| API バージョン分散 | Admin SDK / Webhook TOML / POS extension で宣言が異なる |
| Fulfillment / Draft complete | V2→旧 API、paymentPending→単純 complete のフォールバック（互換のための分岐） |

## 4. 安全性（金額・返金・件数）

| リスク | 現行の扱い |
|--------|------------|
| created∪updated の二重計上 | 注文 id で union |
| オーバーレイと本集計の二重 | オーバーレイ未適用のため現状は二重にならない（死コード） |
| Gift Card と注文の二重 | POS union に含まれる orderId はレガシー加算スキップ |
| 精算の再実行 | 冪等キーで Settlement 行の重複作成を防止。再同期で Shopify 側は更新しうる |
| 点検の再実行 | 冪等なし → 複数回作成しうる |
| 返金ロケーション不一致 | その精算から除外 → **他店計上漏れ／過少**のリスク（設定依存） |
| GraphQL エラー | リトライ／スロットルあり。同期失敗時 create は 500。キャッシュ失敗は精算成功を落とさない箇所あり |
| 過去データ | 履歴は Settlement スナップショット。再計算 API はプレビュー中心 |
| 領収書 | idempotencyKey。POS は createdBy 未送信 |

## 5. Printing API 移行に関する判断（実装しない）

- **現状維持対象として分離**: 集計・特殊返金・DB・metafield
- **置換候補として分離**: order_based の「印字のためだけに作る SETTLEMENT 注文」、cloudprnt の配送手段、領収書の非印字
- 本リポジトリ調査時点で Printing API 実装は行わない（`SHOPIFY.md` §7）

## 6. 未確認事項リスト（横断）

1. Shopify Printing API / POS プリンタでの精算レイアウト印字の実現可否と前提条件
2. CloudPRNT 実機の認証・紙幅・文字コードと payload の適合（設定項目はあるが実行アダプタなし）
3. Shopify POS Pro / Light プラン差分が本アプリ動作に与える影響（コード参照なし）
4. 配送注文・送料を精算に含める／除外する業務ルールの正式決定（コード上は送料非集計）
5. POS キャンセルと Admin キャンセルを件数上どう区別すべきか（コード上区別なし）
6. `ReceiptIssue.createdBy` を運用で埋めるか
7. line item properties を精算／領収書に出す要件の有無
8. ギフトレシート（Shopify Gift Receipt）要件の有無（現行未実装）
9. GitHub 上の CI / 必須チェックの有無（リポジトリ内 workflow なし）
10. Admin API October25 と webhook 2026-04 の併用方針
11. `legacyGiftCardAggregationEnabled` の本番推奨値
12. 死コード（refund overlay / summary fetch）削除の是非
13. 点検 DoneView 文言と order_based 同期のどちらを仕様とするか
14. 精算設定の表示項目名を印字テキストへ反映する要件の有無

## 7. 変更時の推奨確認観点（ドキュメント作業以外）

金額・件数に触れる実装変更時は少なくとも次を確認する:

- `aggregateGasStyleForOrders` の orderCount / itemCount / refundCount 定義
- 返金帰属ゲートとの整合
- 特殊返金イベント反映フラグ
- 売上サマリーが同一プレビューを読むこと
- 冪等キーとロック
- order_based / cloudprnt_direct の分岐

## 2026-10-04 継続開発の整備判断

- Codexを継続ownerとし、既存他tool workstreamはhandoff確認後のみ引き継ぐ。
- runtime/既存フォーマット/API/deploy設定は変更せず、docs・非本番fixtureと品質コマンドを追加。
- lintはdocs確認限定、typecheckは既存Backend tsconfig、testは限定pure関数回帰、buildはBackend/Admin。POS/実印刷・全経路の品質成功とは扱わない。
- 新規ライブラリを増やさず既存TypeScriptとNode test runnerを使用。既存型エラーの大規模修正は別課題。
- Printing API候補はPR #1、preview候補はPR #4（調査時点）であり未統合。main mergeと本番操作は停止。[BACKLOG](BACKLOG.md)に完了条件を保存。

品質baseline: 2026-10-04整備branchではdocs lint・fixture 5件・build成功。typecheckはTS2688（既存tsconfigの@shopify/polaris-types未導入）で停止。Node24.11.1/既存local依存で実行し、Node20クリーン環境とPOS実機は未確認。型エラーは隠さずBACKLOG Q1に残す。
