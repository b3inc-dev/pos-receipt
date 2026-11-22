# 保護顧客データ — 運用チェックリスト（短）

Partner Dashboard での申請そのものはコード外。手順の詳細・文面例は [ERROR_ORDER_ACCESS_PROTECTED_DATA.md](./ERROR_ORDER_ACCESS_PROTECTED_DATA.md) を正とする。

公開アプリ（`shopify.app.public.toml` / Render `pos-receipt`）向け。自社用カスタムは Level 1 が常時利用可能な場合が多く、同一の「Request access」画面が出ないことがある（詳細は上記 docs）。

## 公開前・審査前

### 掲載で使う URL と問い合わせ先（決まり）

T の決定（2026-11-23 1:35・1:50、commercor-site #1）で、公開版のページは紹介サイトに置く。公開する本文の正本は b3inc-dev/commercor-site の `editorial/app_policies.py`（PR #14）。

| 欄 | 値 |
|---|---|
| プライバシーポリシー | https://commercore.b3-inc.com/apps/pos-receipt/privacy/ |
| サポートページ | https://commercore.b3-inc.com/apps/pos-receipt/support/ |
| 問い合わせ先 | お問い合わせフォーム https://b3-inc.com/contact |
| サポートのメール（Partner Dashboard・ポリシー） | app-support@b3-inc.com（全アプリ共通の窓口。T 2026-11-23 1:54・2:00）。届いたら自動の返事でフォームを案内する。受け口（別名か Google グループ）と自動の返事は T が作る（commercor-site docs/SUPPORT_EMAIL_ALIASES.md）。受け口ができてから Partner Dashboard に入れる |
| 事業者 | 株式会社B3（東京都目黒区青葉台1-15-3 AK-4ビル2F） |

- サイトを本番に出し、独自ドメインがつながるまで、この URL は開けない（commercor-site #1）。施行日は公開申請の日に入れる。
- 【アプリの直しは途中】ポリシーは次を先に書いている。公開申請の前にアプリを直す: shop/redact のときに `AppUsageReport` も消す（今は `Shop` と関係が無く消えない）、処理待ちに置いた orders/updated の通知（pg-boss）を 30 日で消す（今は日数を指定していない）。
- ポリシーの文と合わせて読むこと: customers/redact は領収書の宛名だけを消す（特殊返金のメモは消さない）。data_request は記録だけ（店は管理画面の履歴で確かめ、書き出しはフォームで受ける）。

- [ ] 配布方法（Public）が Partner で選択済み
- [ ] 公開 toml の `read_orders` 等スコープと Render `SCOPES` が一致
- [ ] Data protection details（保持・用途・プライバシーポリシー URL）を記入
- [ ] Protected customer data で Order を選択し、用途理由を保存
- [ ] 顧客名等 Level 2 フィールドを使う場合は Protected customer fields も申請
- [ ] **Request access** を送信（Save のみでは下書きのまま）
- [ ] アプリ内プライバシーポリシー導線: 一般設定 `privacyPolicyUrl` または env `PRIVACY_POLICY_URL`（ダミー URL 禁止）。【推測】入れる値は上のプライバシーポリシーの URL（この欄がアプリのポリシーへのリンクか、店のポリシーへのリンクかは T が確かめる。入れるのは T）
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
