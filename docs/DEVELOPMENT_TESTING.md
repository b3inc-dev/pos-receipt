# 開発・品質確認・リリース手順

Codexの行動と承認境界の正本は [DEV_FIRST_THEN_DEPLOY.md](DEV_FIRST_THEN_DEPLOY.md)。本書は再現可能な準備とテスト手順を補足します。

## 1. 独立環境

1. GitHubの最新main/PR/ownerを確認し、専用feature branch/worktreeで作業する。既存dirtyファイルは移動・破棄しない。
2. Node 20（Render設定）を基準に `npm ci` を実行する。既存依存再利用の場合は再現条件を記録する。
3. 開発専用Shopify app/storeとPostgreSQLを用意する。既存 `.env` や本番credentialsはworktreeへコピーしない。[ENV_SETUP.md](ENV_SETUP.md)は変数名の参照に使い、Render本番DBを開発に使わない。
4. DATABASE_URLが開発用であることを確認後のみPrisma client生成・開発DBへの既存migration適用を行う。既存migrationを初期生成し直さない。`npm run setup` はmigrationを含む。
5. 開発専用app configを選択してdevを起動する。本番tomlのautomatically_update_urls_on_devに注意。POSのBackend接続先も開発用と確認する。localhost URLは別端末からそのまま見えない。

未統合Cursor PR #4のpreview scriptsは現在のmainの利用可能コマンドと混同しない。運用に採用する場合はownerと差分を確認する。

## 2. 自動品質コマンド

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

- lint: 現在は `lint:docs` のみ。共通9文書のlocalリンク/競合markerを確認する。アプリJS/TSのESLintやPOS props検証は未整備。アプリlint成功と表現しない。
- typecheck: 既存tsconfigの `tsc --noEmit`。Backend対象、POS拡張は含まれない。既存型エラーを隠さず記録し、修正は別workstreamで対応する。2026-10-04、Node24.11.1/既存依存ではTS2688（tsconfigのtypesに指定された@shopify/polaris-types未導入）で停止した。これより後の型エラーは未評価で、typecheck成功とは扱わない。
- test: DB/Shopify接続なしのレシート回帰5ケース。精算本文全体、返金/商品券、ゼロ売上、スタッフ/割引名/合計/店名、東京暦日境界を確認する。
- build: React Router Backend/Admin build。POS拡張build・実機検証とは別。Shopify CLIの開発専用configで拡張のbuild/targetsを検証する。本番configでdev/deployしない。

tests/pure-source.mjsはTypeScript ASTから指定した実関数を評価する。集計/DB全体をimportせず副作用を避けるための限定ハーネスで、API/GraphQL・UI・統合集計・実印刷を保証しない。外部依存が増えたらハーネスと適切な統合テストを見直し、検証範囲を黙って縮小しない。

fixturesは匿名の合成データ。settlement.txtは変更前の現行出力を固定した期待値。実紙面や全設定を網羅した基準ではない。仕様変更時は期待値更新の根拠と変更前後をPRへ残す。

## 3. 手動受け入れと不足証拠

[workflow確認表](DEV_FIRST_THEN_DEPLOY.md) と [精算チェックシート](SETTLEMENT_CURRENT_STATUS_CHECKLIST.md) を使用する。店舗名・スタッフ・割引・配送/住所・営業日・QR/ロゴ・ギフトの価格非表示・精算/点検/再発行を対象変更に応じ確認する。

店舗POS Lite/Pro、OS/POS version、mPOP等の機種/接続、紙幅、プリンタ切断/再試行/再印刷、長い日本語文字列について画面と実紙面を確認する。Liquid/visual editor設定、logo/QR asset、店別適用範囲はrepo未収録。検証できない場合も安全な実装とPR作成までは進め、未確認とrelease保留理由を記録する。

## 4. リリース

自己/独立レビューと品質結果をPRへ記録しReady停止。main mergeはRender public/inhouse本番Backend auto-deployとpredeploy migrationを伴う。Shopify設定/拡張releaseは別経路。両方とも明示承認が必要で、PR完成は承認ではない。

承認を求める前にbase/HEAD、対象app/store/Renderサービス、DB migration差分、機能/紙面比較、未確認項目と復旧方針を具体化する。承認後はBackendと拡張の互換順序を確認し、監視と非破壊確認を行う。本番注文書込みやrollback等はその承認範囲を別途確認する。
