# AGENTS.md — pos-receipt

調査→設計→実装→品質確認→独立レビューの順で進めます。既存仕様・共通処理を優先し、本番コード・deploy挙動を初期設定で変更しません。

- [README.md](README.md): 構成と既存開発手順
- [docs/DEV_FIRST_THEN_DEPLOY.md](docs/DEV_FIRST_THEN_DEPLOY.md): 開発・deploy・共通運用


## 3ツール共通の入口

共通ルールの正本は本書と既存docsです。Cursor・Codex・Claude Codeは開始前に [docs/DEV_FIRST_THEN_DEPLOY.md](docs/DEV_FIRST_THEN_DEPLOY.md) の共通開発運用・引き継ぎ・リリース境界を確認してください。1 workstreamにつきowner toolは1つ。main直push・force push、本番操作の無承認実行、Backlogへの勝手な着手は禁止です。
