# ターミナル・API から Render を作る方法

管理画面で GitHub 連携がうまくいかない場合の代替案です。

---

## 方法 1: 「Public Git Repository」タブを使う（いちばん簡単）

**b3inc-dev/pos-receipt が GitHub で「Public」リポジトリなら**、GitHub 連携なしで作成できます。

1. Render の **New Web Service** を開く
2. **Source Code** の右にある **「Public Git Repository」** タブをクリック
3. リポジトリ URL を入力:  
   `https://github.com/b3inc-dev/pos-receipt`
4. **Continue** などで次へ進み、Build Command・Start Command・環境変数を設定する

※ リポジトリを **Private** のままにしたい場合は、方法 2 か 3 を検討してください。

---

## 方法 2: Render API でサービスを作成する

Render の **REST API** で Web サービスを新規作成できます。ターミナルから `curl` で実行します。

### 2.1 API キーを取得する

1. **Render ダッシュボード** にログイン  
   https://dashboard.render.com
2. 右上の **Account** または **Account Settings** を開く
3. **API Keys** の項目を開く
4. **Create API Key** でキーを作成し、**コピー**（あとで一度しか表示されない場合があります）

### 2.2 サービス作成リクエストを送る

以下の `curl` は **例** です。`YOUR_API_KEY` を 2.1 で取得したキーに置き換えてください。

```bash
# まず「どのリポジトリを Render で使えるか」は、事前に GitHub 連携が必要な場合があります。
# リポジトリがすでに Render に認識されている前提で、サービス作成の例です。

export RENDER_API_KEY="rnd_xxxxxxxxxxxx"

curl -X POST "https://api.render.com/v1/services" \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "web_service",
    "name": "pos-receipt",
    "runtime": "node",
    "plan": "free",
    "repo": "https://github.com/b3inc-dev/pos-receipt",
    "branch": "main",
    "buildCommand": "npm install && npx prisma generate && npm run build",
    "startCommand": "npx prisma migrate deploy && npx react-router-serve ./build/server/index.js",
    "envVars": [
      { "key": "NODE_VERSION", "value": "20" }
    ]
  }'
```

**注意:**  
- 正確なリクエスト形式（`repo` の指定方法など）は **Render の API ドキュメント** で確認してください:  
  https://api-docs.render.com/reference/create-service  
- リポジトリを「どの Git プロバイダとして使うか」によって、API では `repo` の代わりに `repoId` など別パラメータが必要な場合があります。その場合は、一度ダッシュボードで GitHub を連携したうえで、API で「既存の repo を指定してサービス作成」という流れになることがあります。

### 2.3 環境変数（DATABASE_URL など）を追加する

サービス作成後、環境変数は **API の「環境変数」用エンドポイント** で追加するか、**ダッシュボード** のそのサービスの **Environment** で追加します。

- 環境変数 API: https://api-docs.render.com/reference の「Environment Variables」系のエンドポイントを参照

---

## 方法 3: render.yaml（Blueprint）で定義する

リポジトリに **render.yaml** を入れておき、Render の **Blueprint** で「このリポジトリから一式作成」する方法です。  
**Blueprint を初回作成するときは、まだ「リポジトリを指定する」必要があるため、Public Git Repository か、GitHub 連携ができている必要があります。**

### 3.1 render.yaml をリポジトリに追加

プロジェクト直下に `render.yaml` を置きます（以下は例です）。

```yaml
# render.yaml（Blueprint 用）
services:
  - type: web
    name: pos-receipt
    runtime: node
    plan: free
    buildCommand: npm install && npx prisma generate && npm run build
    startCommand: npx prisma migrate deploy && npx react-router-serve ./build/server/index.js
    envVars:
      - key: NODE_VERSION
        value: "20"
      # DATABASE_URL などは Render ダッシュボードまたは API で追加
```

### 3.2 Blueprint でデプロイ

1. Render ダッシュボードで **New +** → **Blueprint**
2. **Public Git Repository** に `https://github.com/b3inc-dev/pos-receipt` を指定（Public の場合）
3. Render が `render.yaml` を読んでサービスを作成

---

## まとめ

| 方法 | 条件 | 手軽さ |
|------|------|--------|
| **Public Git Repository** | リポジトリが Public | ★★★ いちばん簡単 |
| **API（curl）** | API キー取得、必要なら GitHub 連携 1 回 | ★★ 手順はやや多め |
| **render.yaml + Blueprint** | リポジトリ指定（Public または連携済み） | ★★ 定義をコードで管理したい場合向け |

**まず試すなら:** リポジトリを Public にできる場合は **「Public Git Repository」タブ** で URL を入れて作成するのがいちばん早いです。Private のままにしたい場合は、API ドキュメントを確認しつつ **方法 2（API）** でサービス作成を試してください。
