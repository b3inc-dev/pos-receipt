# PROJECT_CONTEXT — POS Receipt プロジェクト文脈

最終調査基準: リポジトリ現行コード（2026-10-02 時点の main 系調査）。推測はせず、コード／既存 docs で確認できない点は「未確認」と記す。

## 1. 何をするアプリか

店舗の Shopify POS 業務を支援する埋め込みアプリ＋POS UI Extension です。

| 機能 | 概要（コード上の実態） |
|------|------------------------|
| 精算・点検 | ロケーション×日付の売上／返金を集計し、精算レシート用データまたは Shopify 精算注文を生成 |
| 特殊返金・商品券調整 | 注文に紐づくイベントを DB に保存し、精算へ反映（設定により Shopify 返金実行もあり） |
| 領収書 | 注文の合計金額ベースで領収書発行履歴を DB に保存（印字 API 呼び出しなし） |
| 売上サマリー | 精算と同系の集計結果を日次／期間キャッシュし、予算・入店数と合わせて表示 |
| 会員証（LIFF） | 自社用（`APP_DISTRIBUTION=inhouse`）のみ。本調査の精算中核からは独立 |

要件の詳細正本は `docs/posreceipt_requirements_spec.md`。実装進捗メモは `docs/PROGRESS_SUMMARY.md`（日付が古い箇所あり。現行挙動は本ファイル群を優先）。

## 2. システム境界

```
[Shopify Admin / POS]
        │ 注文・決済・返金・ロケーション（正本）
        ▼
[本アプリ Backend: React Router on Render]
  - Admin GraphQL で注文取得・下書き精算注文作成
  - PostgreSQL（Prisma）に Settlement / SpecialRefundEvent / ReceiptIssue / キャッシュ等
  - Webhook: app/uninstalled, compliance, orders/updated
        ▲
[POS UI Extension: extensions/pos-smart-grid]
  - タイル／モーダルから Backend API を呼び出し
```

- **GAS**: 過去の参考実装。アプリは GAS 精算ロジックを Node に移植した箇所が多い（コメント・関数名に GAS 相当と明記）。現行運用の正はアプリ。
- **GitHub**: ソース管理。リポジトリ内に `.github/workflows` は **存在しない**（CI 有無は GitHub 設定側。未確認）。
- **Render**: Web サービス＋DB。`render.yaml` に `pos-receipt` / `pos-receipt-ciara`。

## 3. 用語（本アプリでの意味）

| 用語 | 意味（コード基準） |
|------|-------------------|
| 精算レシート | 日次集計結果の印字用出力。`order_based` なら Shopify 精算注文の POS レシート、`cloudprnt_direct` ならテキスト payload |
| 点検レシート | ゼロ相当の点検用。`isInspection`。冪等キー対象外 |
| 領収書 | `ReceiptIssue`。Shopify の Gift Receipt（ギフトレシート）とは別。コードにギフトレシート実装は **なし** |
| SETTLEMENT 注文 | タグ `SETTLEMENT` の内部注文。集計対象から除外 |
| VIP | 割引コードが `VIP-` で始まる `DiscountCodeApplication` の割当額を `vipPointsUsed` に集計 |
| 特殊返金 | `SpecialRefundEvent`（cash_refund / payment_method_override / receipt_cash_adjustment / voucher_change_adjustment） |
| printMode | Location の `order_based` \| `cloudprnt_direct`（create 時は DB が正） |

## 4. リポジトリ構成（概略）

| パス | 役割 |
|------|------|
| `app/routes/` | Admin UI・API・Webhook |
| `app/services/` | 精算・サマリー・返金・注文詳細等 |
| `app/utils/` | 設定・支払方法・プラン・タイムゾーン等 |
| `extensions/pos-smart-grid/` | POS タイル／モーダル |
| `extensions/common/` | POS から Backend を呼ぶ共通クライアント |
| `prisma/` | スキーマ・マイグレーション |
| `docs/` | 要件・運用・調査メモ＋本基盤ドキュメント |
| `scripts/` | Render migrate / APP_MODE 切替等 |

## 5. 関連ドキュメント地図

| 知りたいこと | 参照 |
|--------------|------|
| 処理フロー・モジュール境界 | `docs/ARCHITECTURE.md` |
| 件数・返金・決済・割引ルール | `docs/BUSINESS_RULES.md` |
| API・Webhook・メタフィールド・印字 | `docs/SHOPIFY.md` |
| 負債・未確認・現行と古い docs の差分 | `docs/DECISIONS.md` |
| 公開／自社デプロイ | `docs/DEPLOY_PUBLIC_AND_INHOUSE.md` |
| GAS との意図比較 | `docs/GAS_vs_APP_IMPLEMENTATION_GAP.md`（一部記述はコードより古い可能性あり） |
| ロケーション／source 検証メモ | `docs/LOCATION_AND_SOURCE_VERIFICATION.md`（精算の `source_name:pos` 記述は現行コードと不一致。`DECISIONS.md` 参照） |

## 6. 未確認（プロジェクト文脈）

- 本番で実際に接続している CloudPRNT プリンタ機種・ポーリング設定の運用手順の完全な現行正本
- Shopify POS の Pro / Light プラン差分への依存の有無（アプリ側に該当チェックは見当たらない）
- GitHub Actions 等のリポジトリ外 CI
