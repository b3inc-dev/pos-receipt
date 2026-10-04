# BACKLOG — 継続開発の未完了事項

候補と不足証拠の一覧。実行指示ではない。依頼された変更に必要な項目だけ対応し、着手時に最新GitHub Issue/PR/ownerと照合する。共通運用は [DEV_FIRST_THEN_DEPLOY.md](DEV_FIRST_THEN_DEPLOY.md)、既知の現行差分は [DECISIONS.md](DECISIONS.md)。

| ID | 項目 | 状態・根拠 | 完了条件 |
|---|---|---|---|
| Q1 | Backend型チェックbaseline | typecheck追加。TS2688: tsconfigの@shopify/polaris-types未導入で停止、以後の型エラーは未評価 | エラー原因を分類し既存挙動を保持して解消 |
| Q2 | アプリ/POS lint・拡張build gate | docs lintのみ。Backend buildとPOS検証は別 | 対象API version/propsを含む再現可能なgate |
| Q3 | 領収書/集計統合テスト | pure関数5ケースのみ | preview/issue、冪等性、返金帰属、VIP、設定の境界を非本番で検証 |
| R1 | 本番レシート正本の保存 | Liquid/visual設定・実紙面未収録 | 店別/レシート種別の設定と匿名見本、QR/配送/ロゴ/スタッフの表示条件 |
| R2 | 領収書テンプレとPOS描画の差 | 管理previewとPOS固定文言・使用項目が異なる | 要件確定、変更前後比較、実印刷確認。自動で統一しない |
| R3 | 点検完了文言と注文同期 | DECISIONS記載の不一致 | 現行設定別挙動を確認し仕様決定後に対応 |
| R4 | CloudPRNT配送/認証/実機 | payload提供まで。プリンタ認証/送信adapterなし | mPOP等実機と紙幅/認証/完了・再送検証 |
| R5 | Printing API移行 | Cursor PR #1、docs-only候補。Codexへhandoff未成立 | 最新公式・既存フォーマット/旧店舗printModeを保持した設計と開発実機検証 |
| R6 | ギフトレシート連携 | アプリ独自連携未実装 | Shopify標準機能との境界、価格非表示と返品導線の要件確定 |
| D1 | 開発専用app/store/DBと遠隔確認 | 接続先/credential供給/公開previewの正本不足 | 本番と分離、スマホから安全に画面確認する手順 |
| D2 | Preview運用 | Cursor PR #4未統合（2026-10-04） | ownerと独立レビューを確認して運用採否決定 |
| D3 | API version差異と店舗互換表 | Admin2025-10/webhook2026-04/POS2026-01/依存2025.10.x | version/targets・OS/POS Lite/Pro・機種の検証記録 |
| D4 | 既存他tool差分 | 元checkoutの拡張toml・Claude branch等 | 前owner停止/commit/差分/qualityとhandoff記録 |

既存MEMO_FUTURE_IMPLEMENTATIONの独自ドメイン・公開summary拡張等は引き続き検討用。今回の整備で勝手に実装しない。
