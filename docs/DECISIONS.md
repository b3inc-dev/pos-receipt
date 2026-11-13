# DECISIONS — 設計判断・負債・未確認

コードと現行 docs から読み取れる判断・負債・未確認の一覧です。新規の仕様推測は含めません。

## 1. 確定している設計判断（コード上の意図）

| ID | 判断 | 根拠 |
|----|------|------|
| D1 | 精算の日次注文取得は GAS 同型（`location_id` + created∪updated∪cancelled）。`source_name:pos` と retailLocation 二次フィルタは付けない。注文検索ピッカーとは境界が異なる（BUSINESS_RULES §1） | `settlementEngine` `buildSettlementPreviewImpl` |
| D2 | 売上サマリー日次の基礎数値は精算プレビューと同一関数で差分ゼロ化 | `salesSummaryEngine.computeAndCacheDailySummary` → `buildSettlementPreview` |
| D3 | 実効 printMode は DB `Location.printMode`。リクエスト body は決定に使わない | `api.settlements.create.tsx` |
| D4 | `cloudprnt_direct` では Shopify 精算注文を作らない | `settlementSyncSettings` + create 分岐 |
| D5 | 精算の冪等キーは `shopId:locationId:targetDate:printMode`。点検は除外 | create ルート |
| D6 | 返金の店舗帰属は設定可能な metafield / Location フラグで制御 | `refundAggregation.server.ts` |
| D7 | VIP は割引コード接頭辞 `VIP-` | `aggregateGasStyleForOrders` |
| D8 | 公開／自社は別 toml・別 Render・APP_MODE。起動時に APP_DISTRIBUTION typo と既知 Render ホスト取り違えを拒否。deploy 後に APP_MODE を verify | `DEPLOY_PUBLIC_AND_INHOUSE.md` + `scripts/lib/deployGuard.mjs` + `server.js` |
| D9 | アプリ課金プラン（Lite/Pro）でサマリー系を制限。精算・領収書・特殊返金は全プラン | `planFeatures.server.ts` |
| D10 | 特殊返金の正本は Gift Card ではなく `SpecialRefundEvent` | schema + API + GAS_vs_APP 記載 |
| D11 | 追加ロケーション $20 従量は未実装。Billing は Lite/Pro 定額のみ。UI で課金済み表示にしない（`EXTRA_LOCATION_USAGE_BILLING_ENABLED=false`） | `app.plan.tsx` + `planFeatures.server.ts` |
| D12 | プライバシーポリシー URL は AppSetting `privacyPolicyUrl` 優先、なければ env `PRIVACY_POLICY_URL`。ダミー固定 URL なし | `privacyPolicyUrl.ts` + 一般設定 / ホーム |
| D13 | `customers/data_request` は注文紐づけの ReceiptIssue / SpecialRefundEvent を列挙し PII 本文なしでログ。`customers/redact` は recipientName と SpecialRefundEvent.note を対称 redact。新規 PII 永続化なし。webhook は 200 | `webhooks.compliance.tsx` |
| D14 | 精算・印字の税／純売上の正は設定税率％による税込逆算。`taxShopify`（注文税×keepRatio）は診断用 | `settlementTaxPure` + preview DTO |
| D15 | レガシー Gift Card API 集計の既定は OFF（検証時のみ ON） | `DEFAULT_SETTLEMENT_SETTINGS` |
| D16 | Printing API は Conditional-Go で並存。旧 order_based / cloudprnt は残置。紙幅は中立 `paperWidthMm`（`cloudprntPaperWidth` と同期） | `printApi.js` + `printPaperWidth.ts` + P0 SETTLEMENT 抑制方針 |

## 2. 古い docs との差分（注意）

| ドキュメント | 記載 | 現行コード |
|--------------|------|------------|
| `LOCATION_AND_SOURCE_VERIFICATION.md` | 精算クエリに `source_name:pos`、retailLocation 二次フィルタ | 精算メインパスでは **どちらも無し**。注文検索には残存 |
| 同・売上サマリー節 | 独自 `shopifyQuery` + filter | 現状は `buildSettlementPreview` 再利用。旧 `fetchSummaryOrders` 等は削除済み |
| `GAS_vs_APP_IMPLEMENTATION_GAP.md` 一部「未対応」節 | タイムゾーンや特殊返金未反映など | 冒頭では対応済と更新済みだが、本文の「現在の実装」段落が古いまま残っている箇所あり。**挙動はコードを正** |
| `PROGRESS_SUMMARY.md` | 最終更新 2026-03-12 | その後の返金帰属・Shopify 返金実行等が追加されている |

## 3. 技術的負債・重複・混在

| 項目 | 内容 |
|------|------|
| 決済名称の二重系（軽減） | 集計バケットキーは依然 `gasNormalizeGatewayLabel`。表示は `resolvePaymentSectionLabel` で raw/formatted/displayLabel を単一マッチ（日本語キー含む）。集計キー自体のハードコードは残存 |
| ロケーション ID 正規化の重複 | `extractLocationNumericId` / `normalizeLocationGid` が複数ファイルに存在（返金照合は `refundAggregationPure` の数値 ID 比較に寄せた） |
| 返金オーバーレイ死コード | `getRefundOverlayForDay` / `computeRefundsOnlyForDay` は定義・export されるが、プレビュー本体からの適用は無く、他ファイルからの import も見当たらない |
| 表示と集計の混在（軽減） | payment section の `gateway` は集計キーのまま。`label` はマスタ解決。マスタ未登録の日本語キーはキー＝表示のまま |
| 精算設定ラベル未使用 | UI で項目名を変えられても `buildSettlementReceiptText` は固定文言 |
| 点検 UI と実装 | DoneView は点検で Shopify 注文を作らない旨を示しうるが、`order_based` では `syncInspectionOrderLikeGas` を呼びうる |
| customAttributes | 取得するが UI 非表示 |
| レガシー Gift Card | 既定 OFF。ON 時のみ API 加算。失敗は握りつぶして続行 |
| 用紙幅キー | 中立 `paperWidthMm` を追加済み。レガシー `cloudprntPaperWidth` は同期エイリアスとして残置（フルリネームは未実施） |
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

## 5. Printing API（Conditional-Go・c69438d 以降）

- **実装済み**: `shopify.printing` ラッパ、精算／領収書／販売の HTML ルート、Admin の prefer フラグ、拡張 `api_version` 2026-07
- **残置**: `order_based` / `cloudprnt_direct`（Location.printMode）。CloudPRNT は Advanced／廃止候補
- **P0 方針**: Printing 主経路では印字用途の SETTLEMENT 作成をスキップ（監査アーカイブはオプトイン）
- **旧経路完全削除**: mPOP 実機 Go 後の別承認
- **触らない核**: 集計・特殊返金 DB・metafield・返金帰属

## 6. 未確認事項リスト（横断）

1. mPOP＋POS 11.11+ 実機での Printing 直印字品質（旧経路削除の前提）
2. CloudPRNT 実機の認証・文字コードと payload の適合（設定項目はあるが実行アダプタなし）
3. Shopify POS Pro / Light プラン差分が本アプリ動作に与える影響（コード参照なし）
4. 配送注文・送料を精算に含める／除外する業務ルールの正式決定（コード上は送料非集計）
5. POS キャンセルと Admin キャンセルを件数上どう区別すべきか（コード上区別なし）
6. `ReceiptIssue.createdBy` を運用で埋めるか
7. line item properties を精算／領収書に出す要件の有無
8. ギフトレシート（Shopify Gift Receipt）要件の有無（現行未実装）
9. Admin API October25 と webhook 2026-04 の併用方針
10. 死コード（refund overlay）削除の是非
11. 点検 DoneView 文言と order_based 同期のどちらを仕様とするか
12. 精算設定の表示項目名を印字テキストへ反映する要件の有無
13. `cloudprntPaperWidth` キー名の完全廃止タイミング（現状は `paperWidthMm` 同期）

## 7. 変更時の推奨確認観点（ドキュメント作業以外）

金額・件数に触れる実装変更時は少なくとも次を確認する:

- `aggregateGasStyleForOrders` の orderCount / itemCount / refundCount 定義
- 返金帰属ゲートとの整合
- 特殊返金イベント反映フラグ
- 売上サマリーが同一プレビューを読むこと
- 冪等キーとロック
- order_based / cloudprnt_direct の分岐
