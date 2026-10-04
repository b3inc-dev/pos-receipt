# AGENTS.md — POS Receipt 開発ガイド

このリポジトリで作業する AI / 開発者向けの入口です。詳細は `docs/` の基盤ドキュメントと既存調査メモを参照してください。

## プロジェクト概要

Shopify POS 店舗向けに、日次精算・特殊返金／商品券調整・領収書・売上サマリー等を提供する React Router + Prisma + POS UI Extension アプリです。売上注文自体は Shopify 上で発生し、本アプリは取得・集計・記録・印字用データ生成を担います。

## 必読ドキュメント

開発運用・owner・引き継ぎ・リリース境界は [docs/DEV_FIRST_THEN_DEPLOY.md](docs/DEV_FIRST_THEN_DEPLOY.md)、既存開発手順は [README.md](README.md) を確認してください。業務仕様・構成は次の順で読みます。

1. `docs/PROJECT_CONTEXT.md` — 目的・境界・用語
2. `docs/ARCHITECTURE.md` — 構成・データフロー・デプロイ
3. `docs/BUSINESS_RULES.md` — コードで確認できる現行業務ルール
4. `docs/SHOPIFY.md` — Shopify API / Webhook / メタフィールド / 印字
5. `docs/DECISIONS.md` — 設計判断と技術的負債・未確認事項

既存の詳細メモ（要件・Render・GAS 比較等）は `docs/` に多数あります。基盤 5 ファイルと重複する内容はそちらを正本とせず、**コード現状は基盤ドキュメントを優先**し、古い調査メモとの差分は `DECISIONS.md` に記載しています。

## 変更時の原則

調査→設計→実装→品質確認→独立レビューの順で進めます。既存仕様・共通処理を優先し、本番コード・deploy挙動を初期設定で変更しません。

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

## 3ツール共通の入口

共通ルールの正本は本書と既存docsです。Cursor・Codex・Claude Codeは開始前に [docs/DEV_FIRST_THEN_DEPLOY.md](docs/DEV_FIRST_THEN_DEPLOY.md) の共通開発運用・引き継ぎ・リリース境界を確認してください。1 workstreamにつきowner toolは1つ。main直push・force push、本番操作の無承認実行、Backlogへの勝手な着手は禁止です。

作業分離は毎回の指示を待たず自動で行う。編集前にGitHubのowner・進行中PRとローカル変更を確認し、同じworkstreamの自分の専用branch/worktreeがあれば再利用、なければGitHubの適切なbaseから作成する。main/stagingの共有checkoutや他toolのworktreeへ直接編集しない。詳細手順は上記の共通運用docsを参照する。

## Codex継続開発（2026-10-04のユーザー方針）

今後の実装ownerはCodex。GitHubを正本とし、原則このチャットだけで完結する。依頼された変更は調査・実装・レシート回帰検証・自己レビュー・push・PR作成まで自律実行する。合理的に判断できる事項は確認を待たず進める。既存他tool作業はowner・停止・handoffを確認し、他toolのbranchを直接編集しない。

- main直commit/push禁止。最新baseから専用feature branch/worktreeを使用する。
- 既存レシートの店舗名・スタッフ名・割引名/合計・配送案内/配送先住所・営業日・QR・ロゴ・ギフト/精算レシート・POS Lite（Light表記含む）/Pro・mPOP等の印刷経路を優先して調査し、不要なフォーマット変更や印刷不能になる変更を避ける。
- API versionを確認し、Printing API変更時は最新公式仕様と既存実装を両方読む。未確認事項はコード・docs・Git履歴から調べる。
- lint/typecheck/test/build、sample order/fixtureによる出力比較、POS表示/印刷影響確認を行う。実行不可・未整備・実機未確認を成功扱いしない。詳細はworkflowのCodex継続開発節。
- production app deploy、POS/Shopify本番設定変更、本番注文書き込み、main merge、不可逆な本番操作は明示承認まで停止する。調査・実装・テスト・branch・push・PR作成は本方針で許可される。
- PR本文にレシート表示、印刷、POS Lite/Pro、API変更、テスト結果、本番反映時の注意点を記載する。
