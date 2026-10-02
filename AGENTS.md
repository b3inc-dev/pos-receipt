# AGENTS.md — POS Receipt 開発ガイド

このリポジトリで作業する AI / 開発者向けの入口です。詳細は `docs/` の基盤ドキュメントと既存調査メモを参照してください。

## プロジェクト概要

Shopify POS 店舗向けに、日次精算・特殊返金／商品券調整・領収書・売上サマリー等を提供する React Router + Prisma + POS UI Extension アプリです。売上注文自体は Shopify 上で発生し、本アプリは取得・集計・記録・印字用データ生成を担います。

## 必読ドキュメント（優先順）

1. `docs/PROJECT_CONTEXT.md` — 目的・境界・用語
2. `docs/ARCHITECTURE.md` — 構成・データフロー・デプロイ
3. `docs/BUSINESS_RULES.md` — コードで確認できる現行業務ルール
4. `docs/SHOPIFY.md` — Shopify API / Webhook / メタフィールド / 印字
5. `docs/DECISIONS.md` — 設計判断と技術的負債・未確認事項

既存の詳細メモ（要件・Render・GAS 比較等）は `docs/` に多数あります。基盤 5 ファイルと重複する内容はそちらを正本とせず、**コード現状は基盤ドキュメントを優先**し、古い調査メモとの差分は `DECISIONS.md` に記載しています。

## 変更時の原則

- **金額・件数・返金・決済集計**に触れる変更は、精算エンジン（`settlementEngine.server.ts`）と売上サマリー（精算プレビュー再利用）の整合を必ず確認する。
- 推測で仕様を書かない。コードまたは管理設定で確認できないことは「未確認」とする。
- GAS は参考実装。現行の正はアプリコードと DB。
- Shopify Printing API への移行実装やアプリコード変更の方針は、本ドキュメント整備タスクの範囲外とし、別 Issue / PR で扱う。

## 主要コード索引

| 領域 | パス |
|------|------|
| 精算集計 | `app/services/settlementEngine.server.ts` |
| 精算注文同期（order_based） | `app/services/settlementOrderGas.server.ts` |
| 返金計上ロケーション | `app/services/refundAggregation.server.ts` |
| 売上サマリー | `app/services/salesSummaryEngine.server.ts` |
| 支払方法マスタ解決 | `app/utils/paymentMethod.server.ts`, `paymentMethodMatch.server.ts` |
| プラン制御 | `app/utils/planFeatures.server.ts` |
| POS 拡張 | `extensions/pos-smart-grid/` |
| POS 共通 API クライアント | `extensions/common/*.js` |
| DB | `prisma/schema.prisma` |
| アプリ設定 TOML | `shopify.app.toml`, `shopify.app.public.toml` |
| Render | `render.yaml`, `server.js` |

## 公開用 / 自社用

- 公開: `shopify.app.public.toml` + Render `pos-receipt` + `APP_MODE=public`
- 自社: `shopify.app.toml` + Render `pos-receipt-ciara` + `APP_DISTRIBUTION=inhouse`
- 手順の詳細は `docs/DEPLOY_PUBLIC_AND_INHOUSE.md`

## やってはいけないこと（調査・ドキュメント作業時）

- アプリケーションコードの無断変更
- 未確認事項を確定仕様として記述すること
- Shopify Printing API 移行の実装を本タスクに含めること
