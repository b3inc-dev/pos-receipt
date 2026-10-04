> Agent運用: 以下の本番手順は参照用です。専用branchからPRを作り、main反映は承認済みPRのmergeで行います。本番手動deploy・Shopify release・本番env変更は明示承認後のみ。今回の初期設定では実行しません。

# 開発環境で確実に動かしてからコミット・デプロイする手順

修正後は **開発環境で動作確認 → 専用branchへコミット・push → PRの品質確認・独立レビュー → Ready** の順で進めます。mainへのmergeはRender本番deployを伴うため、本依頼では停止します。Shopify release・手動deploy・publishも停止します。

---

## 1. 開発環境で確実に動かす

### 1.1 クリーンに開発サーバーを起動する

キャッシュや古いビルドを消してからビルドし直し、そのあと dev を起動します。

```bash
cd /path/to/your/pos-receipt-worktree
npm run dev:clean
```

これで以下が順に実行されます。

1. `build` / `.vite` / `node_modules/.vite` の削除  
2. `npm run build` でビルドし直し  
3. `npm run dev`（`shopify app dev`）の起動  

**手動でやりたい場合:**

```bash
rm -rf build .vite node_modules/.vite
npm run build
npm run dev
```

### 1.2 表示された URL からだけ開く

- ターミナルに表示される **プレビュー用 URL（トンネル or localhost）** をブラウザで開く。
- **その画面から** 管理画面 → **POS を起動**する。
- これで、拡張も API も **同じ開発サーバー** に向き、最新コードが使われます。

※ 本番の管理画面 URL（例: ストア名.myshopify.com/admin）から開くと、API が本番（Render）に向くことがあります。

### 1.3 止めて再実行しても領収書・精算のエラーが変わらない場合の要因

**想定される要因は次の 2 つです。**

| 要因 | 説明 | 確認方法 |
|------|------|----------|
| **A. POS が本番にリクエストしている** | 拡張の `getAppUrl()` は「いまの画面の origin」がトンネル・localhost のときだけ開発 URL を返します。POS の実行環境によっては origin がトンネルにならず、**常に本番（Render）** にリクエストが飛び、開発で直しても変わらないことがあります。 | 精算または領収書モーダル先頭の **「開発時: 接続先」** で **「いま:」** に表示される URL を確認。`https://pos-receipt.onrender.com` なら本番向き。 |
| **B. 開発サーバーが古いビルドのまま** | ソースは直っていても、動いている Node が古い `build/` を読んだままの可能性があります。 | 上で「いま:」がトンネル URL なのにまだエラーなら、`npm run dev:clean` でビルドし直してから dev を起動し直す。 |

**対処（開発で検証するとき）：**

1. **「いま:」が本番 URL のとき**  
   領収書または精算モーダルの **「開発時: 接続先」** で、ターミナルに表示されている **トンネル URL**（例: `https://xxxx.ngrok-free.app`）を入力し、**「開発サーバーを使う」** をタップする。  
   → 以降、そのセッションではすべての API がその開発サーバーに向く。  
   検索・精算プレビューなどを再度試す。
2. **「いま:」がすでにトンネルなのにエラーが続くとき**  
   いったん dev を止め、`npm run dev:clean` でキャッシュ削除・ビルドし直し → `npm run dev` で起動し直す。  
   再度、表示されたトンネル URL から開き直して試す。

解除するときは **「解除」** をタップすると、接続先は通常の判定（origin または本番）に戻ります。

### 1.4 開発環境で確認する項目

| 確認項目 | 期待する動き |
|----------|----------------|
| 精算タイル → モーダルを開く | ロケーション一覧が表示される（Load failed にならない） |
| ロケーション・日付を選んで「精算プレビュー」 | プレビューが表示される（OrderTransactionConnection の 500 が出ない） |
| 領収書タイル → 検索 | オーダー一覧が表示される（location エラーが出ない） |
| 必要なら売上サマリーなど | 同様にエラーにならない |

ここまで問題なければ、**開発環境では確実に処理されている**と判断してよいです。

---

## 2. 検証後は専用branchからPRを更新する

ownerと変更範囲を確認した専用worktreeで、今回変更したファイルだけをstageします。共有main checkoutや他toolのbranchへcommit/pushしません。

```bash
git status --short --branch
git add <今回変更したファイル>
git diff --cached --check
git diff --cached
git commit -m "docs: integrate shared development instructions"
git push origin HEAD:<自分の専用branch>
```

PRにowner・base/HEAD・品質結果・独立レビュー・未完了事項を記録してReadyで停止します。main mergeはRender public/inhouse backendの本番deployとpredeploy migrationを起動します。Shopify設定・拡張releaseは別経路です。以下は明示承認後に判断する運用情報であり、本依頼では実行しません。

- main反映: 承認済みPRのmergeのみ。direct commit/push・force push禁止。
- Shopify公開用release: `npm run deploy:public`。
- Shopify自社用release: `npm run deploy:inhouse`。
- Render backend: 下記の確認済みmain / On Commit経路。専用branchへのpushを本番releaseと混同しない。

## 3. ドキュメントの役割と競合時の扱い

`AGENTS.md`は共通入口、本書は開発運用・owner・引き継ぎ・品質・リリース境界の正本です。業務・構成は `PROJECT_CONTEXT.md`、`ARCHITECTURE.md`、`BUSINESS_RULES.md`、`SHOPIFY.md`、`DECISIONS.md` に分担します。古い詳細メモとコードの差分は `DECISIONS.md` を参照し、コードの現状を正とします。未承認の将来要件を現行実装として扱いません。

PR #2（Cursorの基盤docs、HEAD `013fd67`）の確定内容をPR #3（Codexの共通運用）へ履歴を保持して取り込み、AGENTS.mdの業務指示・索引・公開/自社の区分と3ツール共通指示を統合しました。他toolのbranchは変更しません。取り込んだHEAD以降の変更は再度owner・競合を確認して統合します。

PR #1の印字移行要件は別workstreamです。Printing API移行は本初期設定に含めず、現行の印字実装と移行候補を区別します。取り込みだけでCursorのworkstream全体のownerや未完了作業を引き継いだことにはしません。

## Cursor・Codex・Claude Code 共通開発運用

GitHub のコード・Issue・PR を正本とし、共通指示は `AGENTS.md` と本書に保存する。ツールの個人メモだけで仕様を確定しない。

- 1 logical workstream = 1 owner agent/tool = 1 branch/worktree/PR。同じworkstreamを3ツールが同時編集しない。
- 開始前にGitHub Issue/PRでownerを確認し、担当未確定なら確定してから編集する。別workstreamも変更範囲の重複を確認する。
- mainへのdirect commit/push・force pushは禁止。GitHub正本から専用branch/worktreeを作り、変更ファイルだけをstageする。他者の未コミット変更・Theme Editor由来commitを保持する。
- Backlogは候補一覧であり実行指示ではない。依頼された範囲以外へ勝手に着手しない。
- 調査→設計→実装→品質確認→独立レビュー→Readyの順。仕様競合は編集前に報告する。既存のSMALL/MEDIUM/HIGH RISK分類・DoD・自動merge条件がある場合は維持し、出典不明なら推測で補わない。
- HIGH RISKはReadyで停止し、人間の明示承認後のみmergeする。今回の初期設定ではproduction releaseを伴うmergeも承認待ち。本番手動deploy/publish/rollbackは行わない。
- secrets/token/本番credentialsをrepo・Issue・PR・ログへ保存しない。.env.exampleは必要な変数名と非secretの例のみ。既存接続を置換せず、MCP追加は必要性・権限・credential保存先を先に確認する。

### 3ツール間の引き継ぎ

前ownerは編集・自動処理を止め、commitと作業状態をIssue/PRへ記録して所有権を解放する。次ownerは記録・HEAD・未コミット差分を確認して引き継ぎを明記してから編集する。ownerが不明なら同時着手しない。

Issue本文またはPR本文/コメントに以下を記録する（secretを含めない）:

```text
Workstream:
Owner tool / agent: Cursor | Codex | Claude Code / 担当名
State: Investigating | Working | Ready | Handing off | Done
Branch / worktree:
Base / HEAD commit:
Scope / files:
Risk / 既存分類の根拠:
Quality: コマンド・結果・未実行理由
Independent review:
Unfinished / blockers:
Next action:
Release impact / approval:
Handoff: 前owner停止確認・次owner受領
```

### ツールの読込・権限確認

- Cursor: repo rootのAGENTS.mdと`.cursor/rules/shared-agent-entry.mdc`から共通docsを読む。既存のscoped rule・User/Team Rulesも確認する。
- Codex: repo rootから起動してAGENTS.mdを読む。`.codex/config.toml`は`approval_policy = "on-request"`・`sandbox_mode = "workspace-write"`を指定。信頼済みprojectのみproject configを読込む。管理設定・起動引数・ユーザー設定が上書きする可能性を確認する。
- Claude Code: CLAUDE.mdの`@AGENTS.md` importを使う。既存CLAUDE.md・個人設定・MCP接続を保持する。`/context`のMemory filesと`/memory`で読込先を確認する。
- 全ツールでFull Access・承認全面省略へ変更しない。docsは行動指示であり、GitHub保護や各ツールの実権限の代わりではない。
- 新規セッションで「読込済み指示ファイル、owner、PR base、本番操作の停止条件を挙げて。編集・外部操作はしない」と依頼し、回答と実際のファイルを照合する。別ツールを検証する際もownerを変更しない。

読込仕様の参照: [Cursor Rules](https://cursor.com/docs/rules)、[Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)、[Claude Code memory/imports](https://code.claude.com/docs/en/memory)。

### Shopify App のリリース境界と品質

OAuth・scopes・webhooks・App Proxy・billing・inventory/order mutation・本番env変更はHIGH RISK。手動production deployは明示承認時のみ。旧手順のmain直pushは使わず、PR経由に読み替える。`shopify app deploy`によるShopify設定/拡張のreleaseと、hosted backendのdeployは別経路。開発時も本番アプリのURLを更新しないようapp/config/storeの接続先を確認する。

Renderの下記確認済みサービスはmainを監視しOn Commit auto-deploy。main merge = backend production releaseとして扱い、今回は人間承認までmergeしない。Shopify app config/extension releaseは別経路で、Render deployだけではShopify版のreleaseを意味しない。

品質ゲートはpackage.jsonに存在するlint/typecheck/buildを実行し、存在しないtestコマンドを捏造しない。開発用credentialsが必要な検証は未実行理由をPRに残す。本番DBへのmigrationや接続を品質確認に使わない。

外部API変更時は既存helperのretry上限/backoff・429/GraphQL throttle・error/userErrors処理を確認する。mutationはタイムアウト後の成功不明状態を含めidempotencyと再送を確認し、read用retryをそのまま適用しない。全経路の網羅性・rate limit・secret/log redactionが未確認なら注意点として残し、初期設定ではrefactorしない。

### repoから確認した運用証拠（2026-10-04）

`render.yaml`は参考Blueprintとしてpos-receipt/pos-receipt-ciara、Node20、build=`npm install && npx prisma generate && npm run build`、preDeploy=`npm run render:migrate`、start=`npm run start`を定義する。Render Dashboardでpublic/inhouse双方のGitHub main、On Commit auto-deploy、build/predeploy/start一致とinclude/ignore filter未指定を確認した。Blueprintとの管理上の紐付け自体は未確認。`package.json`のdeploy系scriptはShopify releaseを実行し、backendは別経路。既存API方針の参照: `app/lib/shopifyGraphqlThrottle.server.ts`、`app/services/salesSummaryWebhookQueue.server.ts`（retryLimit=5/backoff）、receipts.issue/settlements.create経路のidempotency。全mutationの再送安全性・secret/log処理は網羅監査未完了。

### 初期設定監査（2026-10-04、本番コード/deploy設定変更なし）

初回監査時はmain protectionなし（API404 Branch not protected）、rulesetなし。現在は下記の「承認後の更新」を参照。GitHub Actions workflowなし、GitHub auto-merge機能は無効。ツールによる既存merge運用とこのAPI設定は別物として扱う。提案はmainのPR必須・force push/削除禁止・必須人間review 0・bypassなし。存在しないCI checkをrequiredに追加しない。保護設定適用は差分を提示して人間承認後のみ。

品質: build成功。package.jsonにlint/test/typecheck scriptなし。 実行Nodeは24.11.1、既存ローカルnode_modulesを再利用したためNode20での完全再現は未確認。アプリコードの差分はなし。既存gateエラーは初期設定PRでrefactorせず別課題とする。

ツール: Cursor desktop CLI 3.23.12、Codex CLI 0.160.0、Claude Code 2.1.246、Shopify CLI 3.88.1。Codexはread-only実セッションで共通指示と参照docsを読み、owner/PR/停止条件/引き継ぎを確認。Cursorの実Agent読込は未確認（cursor-agentは未検出）、Claude Codeは未ログインで実セッション未確認。rootから起動して上記の無編集確認promptを実行し、Claudeは/contextのMemory files、Cursorは適用ルールを照合する。

既存権限/接続: Codexユーザー設定にapproval/sandboxの明示キーはなく、このPRはrepo側だけsafe defaultを追加。repo設定はon-request/workspace-writeを維持するが、再監査時のこのCodex desktop sessionは起動側のdanger-full-access/approval neverで上書きされている。repo設定だけでは実効権限を保証できないため、通常開発ではdesktopの承認・sandbox表示を確認して開始する。今回こちらからFull Accessへ変更した事実はない。Cursor CLIはapprovalMode=allowlistだがsandbox.mode=disabled（既存ユーザー設定を保持、要確認）。Claudeユーザー設定はallow 28件・defaultMode明示なし。Edit(**)、git push、npx prisma、gcloud buildsの広いallowがある。production禁止はdocs上の指示でありpermission denyではない。未ログインのため実効モードとimportは未確認。個人権限は変更していない。Codex/ Cursorの既存MCP、App repoのShopify MCPは保持し、新規MCP・credentialsを追加しない。個人認証/接続情報はコピーしていない。

承認後の更新: 2026-10-04にユーザー承認を受けmain ruleset `main-pr-required-no-force-push` をactiveで適用し、有効ルールをGETで再確認済み。PR必須、force push/削除禁止、required approvals=0、追加承認/Code Owner/last push approvalは無効、bypassなし。required checksは追加せず、既存auto-merge設定は変更していない。

独立レビュー: 別Agentによる読み取りレビューで旧deploy手順の矛盾を修正し、重大な追加指摘なし。実行できないツール/外部設定と既存品質エラーは上記・PRで未確認/未完了として残す。

### 外部設定再監査（2026-10-04、read-only）

Render Settings: `pos-receipt`（srv-d6nuu4chg0os73cd4jg0）と `pos-receipt-ciara`（srv-d6p70sua2pns73f7p0vg）はともに `b3inc-dev/pos-receipt` / main / Auto-Deploy On Commit。Root DirectoryとBuild Filtersは未指定。build=`npm install && npx prisma generate && npm run build`、preDeploy=`npm run render:migrate`、start=`npm run start`。docs mergeでも本番backend deployとpredeploy migrationが走る経路なので承認待ち。設定/手動deploy/Shopify releaseは未実施。

### 依頼ごとに自動で行う作業分離

ユーザーは変更内容を通常の言葉で依頼するだけでよい。Cursor・Codex・Claude Codeの担当toolは、編集前に次を自律実行し、branch/worktreeの作成・再利用について毎回の確認を求めない。

1. 実作業path・GitHub remote・branch・dirty状態・既存worktreeを確認し、GitHub Issue/PRの進行中workstream/owner/範囲/依存と照合する。依頼が読み取りだけならworktree作成は不要。
2. 同じworkstreamを自分が継続中なら専用branch/worktree/PRを再利用する。他toolがownerなら編集せず、停止とhandoffを確認する。新しい独立workstreamならGitHubの最新base（Themeはstaging、他repoはmain）から専用branch＋isolated worktreeを作る。Codex新規branchはcodex/を既定とし、各toolの既存命名規約を保持する。
3. 原checkoutの未commit変更を勝手に移動・stash・破棄しない。作業pathが専用worktree、branchが保護base以外、ownerが自分であることを確かめてから編集する。base追従は現在のworkstreamと競合を確認し、他者の履歴を書き換えない。
4. owner tool/agent・branch/worktree・base/HEAD・scope・quality・未完了・次actionをIssue/PRへ記録し、関連品質確認と必要な独立reviewまで進める。依頼外Backlogへ着手しない。merge/releaseは既存の分類・DoD・承認条件に従う。本依頼のproduction merge停止は継続する。

実行環境がworktree作成を許可しない場合は共有mainへ編集せず、具体的な制約と最小限の対応を報告する。これは各toolの読込後の行動規則であり、GUIでworktree作成を強制する仕組みや権限の全面省略ではない。PR未mergeの間はこのbranchの規則を読めるセッションで利用し、共有baseへの反映後は新規セッションで読込を確認する。

## Codex継続開発とレシート回帰確認

2026-10-04のユーザー指定により、今後の依頼はCodexが調査→実装→検証→自己レビュー→push→PRまで担当する。原則このチャット以外へ確認を求めない。既存の他tool作業は勝手に所有権を移さず、GitHubと既存handoffを確認する。明示承認が必要なのはproduction app deploy、POS/Shopify本番設定変更、本番注文書き込み、main merge、不可逆な本番操作。新しい依頼の合理的な判断・非本番作業は自律実行する。

### 開始時と既存仕様

`git fetch origin`、status、最新main、worktree、open PR/owner、履歴、AGENTS/README/docs/package、POS依存とdeploy設定を確認する。共有checkoutのdirty変更は保持し、専用feature branch（Codexはcodex/）を作る。PR #1（印字要件）とPR #4（preview環境）は2026-10-04調査時点でCursor ownerの未統合PR。未統合案を現行仕様と混同せず、毎回GitHubで最新状態を取得する。

| 確認対象 | main 1557d9eで確認した現状と回帰観点 |
|---|---|
| 店舗名 | sessionLocation、注文retailLocation、DB name/displayNameの経路差。preview APIのlocationNameはPOS領収書画面では未表示 |
| スタッフ名 | orderDetailのlineItems.staffMember.name/firstName/lastName→staffMemberName→OrderDetailSummary。領収書発行createdByはPOS未送信 |
| 割引名/値引合計 | 注文詳細のallocationsとtotalDiscounts、精算のVIP-分離を維持。領収書APIは合計金額のみ |
| 配送案内/住所 | 注文詳細・領収書・精算に配送先住所/案内を出す処理は見当たらない。Shopify標準レシートの実設定は未確認 |
| 営業日 | shopTimezoneの店舗暦日00:00〜翌日直前、精算のcreated/updated/cancelled unionとprocessed fallback。営業時間による独自締め時刻や配送営業日計算は未確認。注文検索の日付条件はUTCで経路差あり |
| QR/ロゴ | レシートQRコード生成は見当たらない。ロゴは管理画面template previewで扱うがPOS領収書画面へ同等に反映されない。会員証barcode/開発QRと区別 |
| ギフト | 独自Gift Receipt連携未実装。標準POSの実紙面/価格非表示条件は別途確認 |
| 精算 | order_basedは設定に従う注文同期＋POS手動印刷。cloudprnt_directはtext payload提供まで。printed statusは物理印刷成功を保証しない |
| 点検 | DoneViewの「注文を作らない」説明とorder_based同期の不一致はDECISIONSに記録済み。勝手にどちらかへ統一しない |
| POS Lite/Pro、mPOP | アプリ課金Lite/Proとは別。店舗プラン・POS/OS version・機種・紙幅・接続と実印字は未確認。mPOP専用アダプタを実装済みと扱わない |
| Liquid | tracked filesと全取得refのGit履歴に.liquidファイルなし。会員証用Liquid例はレシート正本ではない。実店舗のLiquid/visual editor設定の非secret写しと紙面が必要 |

API宣言はAdmin 2025-10、webhook 2026-04、POS 2026-01、ui-extensions依存2025.10.x。使用API/target/propsの互換性を確認し、番号だけ一括更新しない。スタッフフィールドの修正履歴c2cf658と、精算母集団の変更履歴（881ca9c等）を参照する。

Printing API変更時は [最新公式Printing API](https://shopify.dev/docs/api/pos-ui-extensions/latest/target-apis/platform-apis/printing-api) を再確認する。2026-10-04取得の公式表示は2026-07。HTML/画像の直接印刷、PDFはsystem dialog、srcはapplication_urlと同一origin、接続済みPrinter確認と未接続fallback、session token認証を確認した。現行repoには呼び出しなし。POS app version・機種・プランの実動作はこのAPI記述だけで保証しない。

### 検証と完了条件

1. 開発専用app/store/DB/Backendを使用し、API接続先を確認。本番URLfallback、automatically_update_urls_on_dev、本番DBに向くmigrationに注意。`setup`はmigrationを含むため接続先未確認で実行しない。
2. lint/typecheck/test/buildを実行する。現行mainにはbuildのみ存在し、他3scriptは未整備。存在しないscriptは成功と記録せず、必要な変更時に専用PR範囲で品質基盤を整備する。Backend buildだけでPOS拡張を検証済みとしない。
3. 匿名化sample order/fixtureで変更前後を比較。スタッフあり/なし、長い店名、manual/code/automatic割引、VIP、0円/返金/一部返金、配送あり/なしと住所、日付境界、QR/ロゴあり/なし、ギフト価格非表示、精算/点検/再印字を変更に応じ確認する。金額・丸め・件数・順序・改行・文字幅・既存フォーマットを維持する。
4. 58/80mm等の実使用紙幅とmPOP等の実機、iOS/Android、店舗POS Lite/Pro、切断/復帰・再試行・二重印刷を確認する。実機にアクセスできない場合も安全な実装・自動検証・PRまで進め、紙面保証とrelease判断は未確認として残す。本番注文で検証しない。
5. 差分を自己レビューし、AGENTSに従う独立レビュー結果と未実行理由を記録する。docs-only変更に本番機能や印刷の実機成功を主張しない。

### PR本文の必須項目

- Workstream / Owner（Codex）/ State / branch・worktree / base・HEAD / scope・handoff
- レシート表示への影響: 対象項目、変更前後、既存フォーマット、sample/fixture比較
- 印刷への影響: 経路、機種/紙幅、未接続fallback、再印刷、実機未確認
- POS Lite（Light表記含む）/Proへの影響: アプリ課金と分離、確認済み/未確認
- API変更: version・targets・fields・scopes・認証・mutation・再送/冪等性
- テスト結果: lint/typecheck/test/build・POS拡張検証・生成出力・自己/独立レビュー、失敗/未実行理由
- 本番反映時の注意点: Render main auto-deploy/predeploy migration、Shopify別release、承認対象、検証/復旧方針

Readyで停止する。PR作成・pushの許可はmain merge、本番deploy、Shopify/POS本番設定、本番注文mutationの包括承認を意味しない。
