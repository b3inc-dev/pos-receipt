# pos-receipt：新規 Shopify POS アプリの準備手順

`pos-receipt` フォルダの中に、新規の Shopify POS アプリを作成するための手順です。

---

## 事前に用意するもの

1. **Shopify パートナーアカウント**  
   [Shopify パートナー](https://www.shopify.com/partners) にログインできること。

2. **開発用ストア（Dev Store）**  
   パートナーダッシュボードで「ストア」→「追加」から開発用ストアを作成しておく。

3. **Shopify CLI のインストール**  
   まだの場合は、次のどちらかで入れます。

   ```bash
   # グローバル（推奨）
   npm install -g @shopify/cli

   # バージョン確認
   shopify version
   ```

4. **Node.js**  
   Node.js 20 以上（`node -v` で確認）。

5. **Shopify POS アプリ（実機テスト用）**  
   [iOS](https://apps.apple.com/us/app/shopify-point-of-sale-pos/id686830644) または [Android](https://play.google.com/store/apps/details?id=com.shopify.pos) にインストールし、開発用ストアでログインできる状態にしておく。

---

## パターン選び

POS アプリには大きく2種類あります。

| 種類 | 内容 | 向いているケース |
|------|------|------------------|
| **A. Extension-only** | POS のタイル＋モーダルだけ。サーバーなし。 | POS 内だけで完結（例：レシート表示・印刷だけ） |
| **B. フルアプリ** | Web 管理画面（React Router）＋ POS 拡張 | 設定を Web で変更したい、履歴を Web で見たい |

- レシート表示・印刷だけなら **A** で十分です。
- 「管理画面でレシートテンプレートを編集したい」などなら **B** を選びます。

---

## 手順 A：Extension-only（POS だけ）で作る

### Step 1：アプリの土台を作る

**必ず `ShopifyApps` フォルダで**実行してください（`pos-receipt` のひとつ上）。

```bash
cd /Users/develop/ShopifyApps
shopify app init --path pos-receipt --name "POS Receipt"
```

プロンプトが出たら、次のように選びます。

- **Get started building your app:**  
  → **Build an extension-only app**
- **Which organization is this work for:**  
  → 開発用ストアを持っている組織
- **Create this project as a new app on Shopify:**  
  → **Yes, create it as a new app**
- アプリ名は `--name` で指定しているので、そのまま進めて大丈夫です。

これで `pos-receipt` の中に、設定ファイルと `extensions` 用の空フォルダだけのアプリができます。

### Step 2：POS UI 拡張を追加する

```bash
cd /Users/develop/ShopifyApps/pos-receipt
shopify app generate extension
```

- **Extension type:**  
  → **POS smart grid**
- **Extension name:**  
  → そのまま（例: `pos-smart-grid`）で OK。レシート用なら後から `pos-receipt-tile` などにリネームしてもよいです。

これで `extensions/pos-smart-grid/`（または指定した名前）に、`Tile.jsx` と `Modal.jsx` のひな形ができます。

### Step 3：開発サーバーで動かす

```bash
cd /Users/develop/ShopifyApps/pos-receipt
shopify app dev
```

- 「Ready, watching for changes in your app」と出たら成功です。
- キーボードの **`p`** で Developer Console を開き、**View mobile** で QR コードを表示します。
- スマホの POS アプリで QR を読み、開発用ストアにアプリを読み込むと、ホーム画面にタイルが表示されます。

---

## 手順 B：フルアプリ（Web 管理画面 ＋ POS）で作る

stock-transfer-pos のように「Web の管理画面 ＋ POS 拡張」にしたい場合です。

### Step 1：アプリの土台を作る（React Router テンプレート）

```bash
cd /Users/develop/ShopifyApps
shopify app init --path pos-receipt --name "POS Receipt" --template reactRouter
```

プロンプトでは次のように選びます。

- **Get started building your app:**  
  → **Build an app with a web frontend**（または「Build a custom app」など、Web がある方）
- **Which organization...**  
  → 開発用ストアの組織
- **Create this project as a new app on Shopify:**  
  → **Yes, create it as a new app**

これで `pos-receipt` に、Web アプリ（React Router）のひな形ができます。

### Step 2：依存関係を入れる

```bash
cd /Users/develop/ShopifyApps/pos-receipt
npm install
```

### Step 3：POS UI 拡張を追加する

```bash
shopify app generate extension
```

- **Extension type:**  
  → **POS smart grid**
- **Extension name:**  
  → 例: `pos-receipt-tile`

### Step 4：開発サーバーで確認

```bash
shopify app dev
```

- Web ブラウザで管理画面、POS アプリでタイル・モーダルをそれぞれ確認できます。

---

## よくある注意点

1. **`pos-receipt` が空でない場合**  
   `shopify app init --path pos-receipt` は、既存の `pos-receipt` フォルダが**空**のときを想定しています。中に別のファイルがあると上書きやエラーになることがあるので、空の状態で実行してください。

2. **既存アプリに紐づけたい場合**  
   すでにパートナーでアプリを作ってある場合は、次のように `--client-id` を指定できます。

   ```bash
   shopify app init --path pos-receipt --name "POS Receipt" --client-id "あなたのアプリのClient ID"
   ```

3. **POS UI の制約**  
   POS の画面では、[POS UI Extension 用のコンポーネント](https://shopify.dev/docs/api/pos-ui-extensions) だけを使う必要があります。通常の Web 用コンポーネントは使えません。

---

## 次のステップ（レシート機能を実装する場合）

- レシート用の **Print UI extension** を追加する場合は、後から `shopify app generate extension` で **Print** タイプを選べます。
- 既存の POS アプリ（stock-transfer-pos）の拡張構成は、`stock-transfer-pos/extensions/` や `shopify.extension.toml` を参照すると参考になります。

---

## まとめ：コピペ用（Extension-only で始める場合）

```bash
cd /Users/develop/ShopifyApps
shopify app init --path pos-receipt --name "POS Receipt"

cd pos-receipt
shopify app generate extension
# → POS smart grid を選択

shopify app dev
# → 表示された QR を POS アプリで読み取り
```

ここまでできれば、`pos-receipt` の中に新規 Shopify POS アプリの準備は完了です。
