# Shopify CLI での進行（パートナーで作成したアプリ）

パートナーダッシュボードでアプリを作成したあと、**Shopify CLI** だけで開発・デプロイを進める手順です。

---

## 1. パートナーで作ったアプリを CLI で使う

### すでに toml に client_id が入っている場合（現在の pos-receipt）

- `shopify.app.toml` の **client_id** が、パートナーで作ったアプリの Client ID になっていれば、**そのまま CLI で進行できます**。
- 何もリンク作業は不要です。以下から開発・デプロイに進んでください。

### 別のアプリを「このプロジェクト」に紐づけたい場合

パートナーで新しく作ったアプリを、このリポジトリの「いま使うアプリ」にしたいときは、**設定のリンク**をします。

1. ターミナルでプロジェクトのルートに移動する。
   ```bash
   cd /Users/develop/ShopifyApps/pos-receipt
   ```

2. 次のコマンドを実行する。
   ```bash
   npx shopify app config link
   ```
   または（CLI がグローバルに入っている場合）:
   ```bash
   shopify app config link
   ```

3. プロンプトで **既存のアプリを選択** する。
   - パートナーにログインしていれば、アプリ一覧が表示されます。
   - ダッシュボードで作った「POS Receipt」や「POS Receipt - Ciara」を選びます。

4. リンクが完了すると、`shopify.app.toml` の **client_id** が、選んだアプリのものに書き換わります（既存の toml がある場合は更新されます）。

これで「パートナーで作ったアプリ」＝「このプロジェクトで CLI が使うアプリ」になります。

---

## 2. 開発を CLI で進める

### 開発サーバーを起動する

```bash
cd /Users/develop/ShopifyApps/pos-receipt
npm run dev
```

または:

```bash
npx shopify app dev
```

- 初回は **開発ストアを選ぶ** プロンプトが出ます。テスト用のストアを選んでください。
- 起動すると、管理画面や POS のプレビュー用 URL が表示されます。そこからアプリを開いて動作確認できます。

### よく使うコマンド

| やりたいこと       | コマンド |
|--------------------|----------|
| 開発してプレビュー | `npm run dev` または `npx shopify app dev` |
| アプリ情報を表示   | `npx shopify app info` |
| 拡張を追加したい   | `npx shopify app generate extension` |

---

## 3. デプロイを CLI で行う

### デプロイの流れ

1. コードをコミットする（任意だが推奨）。
2. 次のコマンドでデプロイする。
   ```bash
   npm run deploy
   ```
   または:
   ```bash
   npx shopify app deploy
   ```

- デプロイ先は、**いま有効な設定ファイル**（`shopify.app.toml` や `shopify.app.public.toml`）に書かれた **client_id** のアプリです。
- 公開用と自社用でアプリを分けている場合は、あとで **設定ファイルの切り替え** と **APP_MODE** の切り替えが必要になります（`docs/PUBLIC_INHOUSE_APP_DEFINITION.md` 参照）。

### application_url と redirect_urls について

- 現在の `shopify.app.toml` では、`application_url` と `redirect_urls` がまだデフォルトのままの場合があります。
- **開発中**は、`shopify app dev` 実行時に CLI がトンネル URL を一時的に使うため、そのままでも開発は可能です。
- **本番で自分のサーバー（例: Render）にデプロイするとき**は、そのサーバーの URL を toml に書き、パートナーの「アプリの URL」も同じにしてください。

---

## 4. 公開用・自社用の 2 本ある場合

- **公開用**: `shopify.app.public.toml` を用意し、公開用アプリの client_id と本番 URL を書く。
- **自社用**: `shopify.app.toml` に自社用アプリの client_id と本番 URL を書く（または `shopify.app.ciara.toml` など別ファイルにする）。

デプロイするアプリを切り替えるときは、次のように **使う toml を切り替えてから** デプロイします。

```bash
# 公開用にデプロイする場合（APP_MODE も public に合わせたうえで）
npx shopify app config use shopify.app.public.toml
npx shopify app deploy

# 自社用にデプロイする場合（APP_MODE も inhouse に合わせたうえで）
npx shopify app config use shopify.app.toml
npx shopify app deploy
```

`deploy:public` / `deploy:inhouse` のような npm スクリプトを用意すると、APP_MODE の書き換えと toml の切り替えをまとめて実行できます（`PUBLIC_INHOUSE_APP_DEFINITION.md` 参照）。

---

## 5. まとめ

- **パートナーでアプリを作ったあとも、Shopify CLI で進行して問題ありません。**
- 既に `shopify.app.toml` に client_id が入っていれば、そのまま `npm run dev` で開発、`npm run deploy` でデプロイできます。
- 別アプリをこのプロジェクトに紐づけたいときだけ、`npx shopify app config link` で既存アプリを選べばよいです。
