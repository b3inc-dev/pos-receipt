# 保護顧客データ — 運用チェックリスト（短）

Partner Dashboard での申請そのものはコード外。手順の詳細・文面例は [ERROR_ORDER_ACCESS_PROTECTED_DATA.md](./ERROR_ORDER_ACCESS_PROTECTED_DATA.md) を正とする。

公開アプリ（`shopify.app.public.toml` / Render `pos-receipt`）向け。自社用カスタムは Level 1 が常時利用可能な場合が多く、同一の「Request access」画面が出ないことがある（詳細は上記 docs）。

## 公開前・審査前

- [ ] 配布方法（Public）が Partner で選択済み
- [ ] 公開 toml の `read_orders` 等スコープと Render `SCOPES` が一致
- [ ] Data protection details（保持・用途・プライバシーポリシー URL）を記入
- [ ] Protected customer data で Order を選択し、用途理由を保存
- [ ] 顧客名等 Level 2 フィールドを使う場合は Protected customer fields も申請
- [ ] **Request access** を送信（Save のみでは下書きのまま）
- [ ] アプリ内プライバシーポリシー導線: 一般設定 `privacyPolicyUrl` または env `PRIVACY_POLICY_URL`（ダミー URL 禁止）
- [ ] GDPR compliance webhook（`customers/data_request` / `redact` / `shop/redact`）が公開 URL で到達可能

## 開発ストア検証

- [ ] Request access 後、開発ストアで Order 検索・領収書・精算が 500（protected data）にならない
- [ ] 必要ならアプリ再インストールでスコープ再同意

## App Store / 本番ストア

- [ ] リスティング提出後の審査で protected data が承認されるまで、一般ストアでは Order アクセスが拒否されうることを把握
- [ ] 承認後、対象ストアで再インストールまたはスコープ更新を案内

## 本リポジトリでやらないこと

- Partner 申請ボタンの代行・本番 Dashboard 操作
- 推測での「承認済み」断定
