> Agent運用: 以下の本番手順は参照用です。専用branchからPRを作り、main反映は承認済みPRのmergeで行います。本番手動deploy・Shopify release・本番env変更は明示承認後のみ。今回の初期設定では実行しません。

# 開発環境で確実に動かしてからコミット・デプロイする手順

修正後は **まず開発環境で動作を確認** し、問題なければ **コミット → プッシュ → デプロイ** する流れにすると安全です。

---

## 1. 開発環境で確実に動かす

### 1.1 クリーンに開発サーバーを起動する

キャッシュや古いビルドを消してからビルドし直し、そのあと dev を起動します。

```bash
cd /Users/develop/ShopifyApps/pos-receipt
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

## 2. 問題なければコミット・プッシュ・デプロイ

開発環境で上記がすべて問題ないことを確認してから、以下を実行します。

### 2.1 コミット

```bash
git add -A
git status   # 変更内容を確認
git commit -m "fix: OrderTransactionConnection nodes, locations like POS Stock, dev:clean script"
```

### 2.2 プッシュ

```bash
git push
```

### 2.3 デプロイ

- **拡張＋バックエンドをまとめてデプロイする場合**
  - 公開用: `npm run deploy:public`
  - 自社用: `npm run deploy:inhouse`
- **Render が Git 連携している場合**
  - push 後に自動でビルド・デプロイされることが多いので、Render のデプロイ状況を確認する。

---

## 3. まとめ

| 段階 | やること |
|------|----------|
| **開発で確実に動かす** | `npm run dev:clean` → 表示された URL から開く → ロケーション・精算プレビューを確認 |
| **問題なければ** | コミット → プッシュ → デプロイ（または push で自動デプロイを確認） |

「まず開発環境で確実に処理される」→「そのあとコミット・プッシュ・デプロイ」という順で進められるようにしています。


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

Renderの監視branch・auto-deploy・build filter・実際のbuild/predeploy/start・public/inhouseの対象は外部設定で未確認。main mergeが本番deployを起こす場合はproduction releaseとして扱う。今回は確認・人間承認までmergeしない。

品質ゲートはpackage.jsonに存在するlint/typecheck/buildを実行し、存在しないtestコマンドを捏造しない。開発用credentialsが必要な検証は未実行理由をPRに残す。本番DBへのmigrationや接続を品質確認に使わない。

外部API変更時は既存helperのretry上限/backoff・429/GraphQL throttle・error/userErrors処理を確認する。mutationはタイムアウト後の成功不明状態を含めidempotencyと再送を確認し、read用retryをそのまま適用しない。全経路の網羅性・rate limit・secret/log redactionが未確認なら注意点として残し、初期設定ではrefactorしない。

### repoから確認した運用証拠（2026-10-04）

`render.yaml`は参考Blueprintとしてpos-receipt/pos-receipt-ciara、Node20、build=`npm install && npx prisma generate && npm run build`、preDeploy=`npm run render:migrate`、start=`npm run start`を定義する。実適用/監視branchは未確認。`package.json`のdeploy系scriptはShopify releaseを実行し、backendは別経路。既存API方針の参照: `app/lib/shopifyGraphqlThrottle.server.ts`、`app/services/salesSummaryWebhookQueue.server.ts`（retryLimit=5/backoff）、receipts.issue/settlements.create経路のidempotency。全mutationの再送安全性・secret/log処理は網羅監査未完了。

### 初期設定監査（2026-10-04、本番コード/deploy設定変更なし）

main protectionなし（API404 Branch not protected）、rulesetなし。GitHub Actions workflowなし、GitHub auto-merge機能は無効。ツールによる既存merge運用とこのAPI設定は別物として扱う。提案はmainのPR必須・force push/削除禁止・必須人間review 0・bypassなし。存在しないCI checkをrequiredに追加しない。保護設定適用は差分を提示して人間承認後のみ。

品質: build成功。package.jsonにlint/test/typecheck scriptなし。 実行Nodeは24.11.1、既存ローカルnode_modulesを再利用したためNode20での完全再現は未確認。アプリコードの差分はなし。既存gateエラーは初期設定PRでrefactorせず別課題とする。

ツール: Cursor desktop CLI 3.23.12、Codex CLI 0.160.0、Claude Code 2.1.246、Shopify CLI 3.88.1。Codexはread-only実セッションで共通指示と参照docsを読み、owner/PR/停止条件/引き継ぎを確認。Cursorの実Agent読込は未確認（cursor-agentは未検出）、Claude Codeは未ログインで実セッション未確認。rootから起動して上記の無編集確認promptを実行し、Claudeは/contextのMemory files、Cursorは適用ルールを照合する。

既存権限/接続: Codexユーザー設定にapproval/sandboxの明示キーはなく、このPRはrepo側だけsafe defaultを追加。現在のdesktop sessionはworkspace-write相当。Cursor CLIはapprovalMode=allowlistだがsandbox.mode=disabled（既存ユーザー設定を保持、要確認）。Claudeユーザー設定にはallow rule 28件がありdefaultModeは明示なし（実効権限は未確認）。Codex/ Cursorの既存MCP、App repoのShopify MCPは保持し、新規MCP・credentialsを追加しない。個人認証/接続情報はコピーしていない。

承認後の更新: 2026-10-04にユーザー承認を受けmain ruleset `main-pr-required-no-force-push` をactiveで適用し、有効ルールをGETで再確認済み。PR必須、force push/削除禁止、required approvals=0、追加承認/Code Owner/last push approvalは無効、bypassなし。required checksは追加せず、既存auto-merge設定は変更していない。

独立レビュー: 別Agentによる読み取りレビューで旧deploy手順の矛盾を修正し、重大な追加指摘なし。実行できないツール/外部設定と既存品質エラーは上記・PRで未確認/未完了として残す。
