# 設定画面まわり実装の dev 確認手順

追加した一般設定・精算設定・印字設定・予算設定・ロケーション拡張を、ローカルで確認するための手順です。

---

## 1. 前提

- Node.js 20 以上
- PostgreSQL（ローカル or Docker or Render/Supabase の URL）
- Shopify パートナーアプリと開発ストアが紐づいていること（`shopify.app.toml` の `client_id`）

---

## 2. 環境準備

### 2.1 .env の用意

```bash
cd /Users/develop/ShopifyApps/pos-receipt
cp .env.example .env
```

`.env` に最低限 **DATABASE_URL** を設定する（PostgreSQL の接続文字列）。  
Shopify 用（SHOPIFY_API_KEY 等）は `npm run dev` 時に CLI が補完する場合もありますが、必要な場合は `docs/ENV_SETUP.md` を参照。

### 2.2 DB マイグレーション（新規カラムの反映）

ロケーションの §4.2.3〜4.2.5 用カラムを入れたい場合：

```bash
cd /Users/develop/ShopifyApps/pos-receipt
npx prisma generate
npx prisma migrate deploy
```

開発で「未適用マイグレーションをまとめて適用」する場合：

```bash
npx prisma migrate dev
```

---

## 3. 開発サーバー起動（確認用 dev コード）

```bash
cd /Users/develop/ShopifyApps/pos-receipt
npm run dev
```

または:

```bash
npx shopify app dev
```

- 初回は開発ストアを選ぶプロンプトが出るので、テスト用ストアを選択する。
- 起動後、ターミナルに **管理画面のプレビューURL** が表示される（例: `https://admin.shopify.com/store/xxx/apps/...`）。

---

## 4. 確認する画面とパス

ブラウザで「ストアの管理画面」からアプリを開くか、表示された URL に `?shop=ストア.myshopify.com` が付いていればそのまま開く。

| 確認内容           | 開くパス |
|--------------------|----------|
| 設定トップ         | `/app/settings` |
| 一般設定（§3）      | `/app/general-settings` |
| 精算設定（§5）      | `/app/settlement-settings` |
| 印字設定（§12）     | `/app/print-settings` |
| 予算設定（§11）     | `/app/budget-settings` |
| ロケーション拡張    | `/app/settings` → 下の「ロケーション設定」で各店舗の「集計・表示対象」「プリンタプロファイルID」「売上サマリー関連」が編集できること |

- 左サイドメニュー（s-app-nav）または上部ナビから「一般設定」「精算設定」「印字設定」「予算設定」のリンクで遷移できること。
- 各設定画面で項目を変更 → 「保存」→ 再読み込みで値が保持されていることを確認。

---

## 5. よく使うコマンド一覧（コピペ用）

```bash
# プロジェクトへ移動
cd /Users/develop/ShopifyApps/pos-receipt

# Prisma クライアント生成 + マイグレーション適用
npx prisma generate
npx prisma migrate deploy

# 開発サーバー起動（実装確認用）
npm run dev
```

管理画面が開いたら、上記パスで各設定画面を開いて表示・保存ができるか確認してください。

---

## 6. 反映されないときの要因と対処

### 要因 1: マイグレーションが未適用（最も多い）

**症状**
- 設定ページでロケーションを保存するとエラーになる、または「保存しました」でも再読み込みすると値が戻る
- ロケーションの「集計・表示対象」「プリンタプロファイルID」「売上サマリー関連」が保存されない

**理由**  
DB にまだ **Location の新カラム**（`includeInStoreTotals`, `includeInOverallTotals`, `visibleInSummaryDefault`, `printerProfileId`, `cloudprntEnabled`, `summaryTargetGroup`, `budgetTargetEnabled`, `footfallTargetEnabled`）が存在しないため、Prisma の `upsert` が失敗するか、該当カラムへの書き込みができません。

**確認**

```bash
cd /Users/develop/ShopifyApps/pos-receipt
npx prisma migrate status
```

「未適用のマイグレーションがあります」や、`20260312100000_add_location_4_2_3_to_4_2_5` が一覧に出る場合は未適用です。

**対処**

```bash
cd /Users/develop/ShopifyApps/pos-receipt
npx prisma generate
npx prisma migrate deploy
```

適用後、**dev サーバーを一度止めてから** `npm run dev` で再起動し、設定ページで再度保存を試してください。

---

### 要因 2: 新規画面のリンクが見えない（Embedded App）

**症状**  
「一般設定」「精算設定」「印字設定」「予算設定」がメニューにない、または左サイドバー（s-app-nav）が表示されない。

**理由**  
管理画面を iframe で開く Embedded App では、ストアによっては左サイドメニューが非表示になることがあります。

**対処**
- **設定ページ**（`/app/settings`）を開き、画面上部の **「一般設定」「精算設定」「印字設定」「予算設定」** のドロップダウン（secondaryActions）から遷移する
- またはブラウザのアドレスバーで直接次の URL を開く（`?shop=あなたのストア.myshopify.com` はそのまま付けてください）:
  - `/app/general-settings`
  - `/app/settlement-settings`
  - `/app/print-settings`
  - `/app/budget-settings`

---

### 要因 3: dev サーバーやビルドが古い

**症状**  
コードは直したが、画面やメニューが変わらない。

**対処**
- dev サーバーを止めてから再度 `npm run dev` で起動する
- ブラウザのハードリロード（Ctrl+Shift+R / Cmd+Shift+R）またはキャッシュ無効で再読み込みする
