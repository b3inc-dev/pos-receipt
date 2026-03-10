# DB マイグレーション手順（MVP）

`prisma/schema.prisma` は要件書 第11章・第20章に基づく MVP 用スキーマです。

## 前提

- **Prisma 6.x** を利用することを推奨します（`package.json` に `"prisma": "^6.16.0"`, `"@prisma/client": "^6.16.0"` を指定）。Prisma 7 では `datasource url` の指定方法が変わっています。
- **PostgreSQL** を想定（本番: Render / Supabase 等）。開発では同じ PostgreSQL またはローカル Postgres を使用。
- 開発で **SQLite** を使う場合は、`schema.prisma` の `datasource db` を `provider = "sqlite"` に変更し、`url = "file:./dev.db"` にします。その場合、`@db.Decimal` は SQLite で未対応のため、`Decimal` は `Float` に変更するか、`String` で金額を保存する必要があります（本番 Postgres に合わせるなら開発も Postgres 推奨）。

## 初回セットアップ

1. **環境変数**
   - `.env` に `DATABASE_URL` を設定する。
   - 例（PostgreSQL）:  
     `DATABASE_URL="postgresql://user:password@localhost:5432/pos_receipt?schema=public"`

2. **Prisma のインストール**（未導入時）
   - ルートで:  
     `npm install prisma @prisma/client --save`  
     `npm install -D prisma --save-dev` は不要（prisma は dev でも可）。

3. **マイグレーションの作成・適用**
   ```bash
   npx prisma migrate dev --name init_mvp
   ```
   - 初回は `prisma/migrations/` にマイグレーション SQL が生成され、DB に適用されます。

4. **Prisma Client の生成**
   ```bash
   npx prisma generate
   ```
   - `migrate dev` 実行時にも自動で行われます。

## 本番デプロイ時

- Render 等では起動前に以下を実行する想定です。
  ```bash
  npx prisma generate && npx prisma migrate deploy
  ```
- `migrate deploy` は未適用のマイグレーションのみを適用し、新規マイグレーションは作成しません。

## スキーマ変更時

1. `prisma/schema.prisma` を編集する。
2. 以下で差分マイグレーションを作成・適用する。
   ```bash
   npx prisma migrate dev --name 変更内容の短い説明
   ```

## モデル一覧（MVP）

| モデル | 要件書 | 用途 |
|--------|--------|------|
| Session | Shopify アプリ | セッション保存 |
| Shop | 20.1 | ショップ・プラン |
| Location | 20.2 | ロケーション・印字方式・サマリー設定 |
| AppSetting | 20.3 | キー値設定 |
| Settlement | 20.4 | 精算履歴 |
| SpecialRefundEvent | 20.5 | 特殊返金・商品券調整イベント |
| ReceiptTemplate | 20.6 | 領収書テンプレート（1本） |
| ReceiptIssue | 20.7 | 領収書発行履歴 |
| Budget | 20.8 | 予算 |
| FootfallReport | 20.9 | 入店数 |
| SalesSummaryCacheDaily | 20.10 | 日次サマリーキャッシュ |
| SalesSummaryCachePeriod | 20.11 | 期間サマリーキャッシュ |
