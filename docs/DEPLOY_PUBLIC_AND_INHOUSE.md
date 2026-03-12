# 公開アプリと自社用カスタムアプリのデプロイ（2種運用）

POS Stock と同様に、**同じコードベース**で「公開用アプリ」（App Store 用）と「自社用カスタムアプリ」の2つを運用するときの手順です。

---

## 1. 何が違うか

| 項目 | 公開アプリ | 自社用カスタムアプリ |
|------|------------|----------------------|
| 設定ファイル | `shopify.app.public.toml` | `shopify.app.toml` |
| バックエンド URL 例 | https://pos-receipt.onrender.com | https://pos-receipt-ciara.onrender.com |
| POS 拡張が呼ぶ API | 上記（公開用） | 上記（自社用） |
| プラン・課金 | Billing API でスタンダード/プロを判定 | 制限なし（全機能利用可能） |

**重要**: POS 拡張（extensions）は、**ビルド時に** `extensions/common/appUrl.js` の **APP_MODE** を見て「どちらのバックエンド URL を呼ぶか」を決めます。  
そのため、**公開用にデプロイするときは APP_MODE = "public"、自社用にデプロイするときは APP_MODE = "inhouse"** になっている必要があります。

---

## 2. 自社アプリとして導入するために必要なこと

### 2.1 パートナーで「自社用」と「公開用」を別アプリにする（推奨）

POS Stock と同様に、**自社用**と**公開用**で **別々の Shopify アプリ**（別の client_id）にすると、運用が分かりやすくなります。

| 種類 | 設定ファイル | 用途 | デプロイ先 URL 例 |
|------|--------------|------|-------------------|
| **自社用** | `shopify.app.toml` | 自社ストアにインストールするカスタムアプリ | pos-receipt-ciara.onrender.com |
| **公開用** | `shopify.app.public.toml` | App Store で販売する公開アプリ | pos-receipt.onrender.com |

- **自社用**のアプリ「POS Receipt - Ciara」の Client ID は、`shopify.app.toml` に **`ec5374155070d767e71bbe5c258160e2`** として設定済みです。
- **公開用**のアプリは、既存の「POS Receipt」を公開アプリとして使い、`shopify.app.public.toml` の `client_id` はそのままにします。
- 自社用の Render では、上記 Client ID に対応する **SHOPIFY_API_KEY** と **SHOPIFY_API_SECRET** を設定してください（下記 2.2 参照）。

### 2.2 自社用の Render（バックエンド）に必要な環境変数

自社用のバックエンド（例: pos-receipt-ciara.onrender.com）では、**公開用とは別のアプリ認証**と**自社用フラグ**を設定します。

| 変数名 | 値 | 意味 |
|--------|-----|------|
| **SHOPIFY_API_KEY** | `ec5374155070d767e71bbe5c258160e2` | 自社用アプリ「POS Receipt - Ciara」の Client ID。公開用の値とは別にする。 |
| **SHOPIFY_API_SECRET** | （パートナーで取得） | 上記アプリの Client secret。パートナー → POS Receipt - Ciara → クライアントの秘密鍵 で確認。 |
| **SHOPIFY_APP_URL** | `https://pos-receipt-ciara.onrender.com` | **必須。** この Render の URL。未設定だと管理画面で真っ白になる。認証・リダイレクトに使用。 |
| **APP_DISTRIBUTION** | `inhouse` | このサーバーは自社用。プラン制限なし・全機能解放。 |
| **DATABASE_URL** | （PostgreSQL 接続文字列） | 自社用で別 DB にするか、公開用と共有するかは運用方針に合わせる。 |
| **SCOPES** | `read_orders,read_locations` | スコープ。**カンマの前後にスペースを入れない**（`read_orders, read_locations` だと2つ目に余分なスペースが入り認証エラーの原因になることがあります）。 |

- **重要**: 自社用の Render では、必ず **SHOPIFY_API_KEY** と **SHOPIFY_API_SECRET** を「POS Receipt - Ciara」用の値にしてください。公開用アプリの値のままにすると認証エラーになります。
- **SHOPIFY_APP_URL** が空や違う URL のままだと、管理画面からアプリを開いたときに **何も表示されない（真っ白）** になります。必ず自社用の URL に設定してください。
- **APP_DISTRIBUTION** が未設定や typo だと「公開用」扱いになり、Billing による制限がかかります。値は大文字小文字どちらでも構いません（`inhouse` / `INHOUSE` など）。

---

## 3. デプロイのやり方

### 3.1 CLI（npm スクリプト）でデプロイする（推奨）

リポジトリに **deploy:public** と **deploy:inhouse** の npm スクリプトを用意してあります。

- **公開アプリ用にデプロイするとき**
  ```bash
  npm run deploy:public
  ```
  → APP_MODE を "public" に書き換え → 公開用の config を有効化 → `shopify app deploy` を実行します。

- **自社用にデプロイするとき**
  ```bash
  npm run deploy:inhouse
  ```
  → APP_MODE を "inhouse" に書き換え → 自社用の config を有効化 → `shopify app deploy` を実行します。

実行後、ディスク上の `extensions/common/appUrl.js` は、**いまデプロイした方のモード**に変わります。次に別の方をデプロイするときは、もう一方のスクリプトを実行すれば切り替わります。

### 3.2 手動で appUrl.js を書き換えてからデプロイする

1. `extensions/common/appUrl.js` の **APP_MODE** を `"public"` または `"inhouse"` に変更する。
2. 公開用なら `shopify app config use shopify.app.public.toml`、自社用なら `shopify app config use shopify.app.toml` を実行。
3. `shopify app deploy` を実行。

### 3.3 パートナーダッシュボードからデプロイする場合

1. **デプロイする「どちらのアプリ」に合わせて APP_MODE を合わせる**
   - **公開アプリ**にデプロイする → `extensions/common/appUrl.js` の `APP_MODE` を **"public"** にし、保存する。
   - **自社用カスタムアプリ**にデプロイする → `APP_MODE` を **"inhouse"** にする。
2. 変更を **コミットしてプッシュ**する（ダッシュボードが Git 連携している場合）。
3. **パートナーダッシュボード**で、デプロイしたい方のアプリを開き、**デプロイ**を実行する。

※ どちらのアプリにデプロイするかと、appUrl.js の APP_MODE が一致していれば、パートナーダッシュボードからでも問題ありません。

---

## 4. 公開アプリと自社用の両方にデプロイする

同じ内容を**公開アプリ**と**自社用カスタムアプリ**の両方に反映したいときは、次の順で行います。

```bash
cd /Users/develop/ShopifyApps/pos-receipt

# 1. 公開アプリにデプロイ（APP_MODE=public で拡張をビルドし、公開アプリにデプロイ）
npm run deploy:public

# 2. 自社用カスタムアプリにデプロイ（APP_MODE=inhouse に切り替え、自社用にデプロイ）
npm run deploy:inhouse
```

- 実行後、ディスク上の `appUrl.js` は **inhouse** のままになります（最後に実行した `deploy:inhouse` のため）。次に公開だけデプロイするときは `npm run deploy:public` を実行すれば切り替わります。

---

## 5. 1本のデプロイで自社ストアだけ全機能にしたい場合（CUSTOM_APP_STORE_IDS）

**同じバックエンド URL（公開用）1本**しか運用していないが、特定のストア（自社ストア）だけ「自社用と同様に全機能」にしたい場合は、バックエンドの環境変数 **`CUSTOM_APP_STORE_IDS`** を設定します。

| 項目 | 内容 |
|------|------|
| **設定例** | `CUSTOM_APP_STORE_IDS=my-store.myshopify.com,other.myshopify.com` |
| **形式** | ショップのドメインをカンマ区切りで列挙（スペースはトリムされる） |
| **動作** | ここに含まれるストアでアプリを開いたとき、**inhouse 扱い**になり、全機能が利用可能になる |

自社用専用のデプロイ（別 URL）で **APP_DISTRIBUTION=inhouse** を設定している場合は、`CUSTOM_APP_STORE_IDS` は不要です。

---

## 6. まとめ

| やり方 | 公開アプリ | 自社用 |
|--------|------------|--------|
| **パートナーダッシュボード** | APP_MODE=public で push → 公開アプリのダッシュボードからデプロイ | APP_MODE=inhouse で push → カスタムアプリのダッシュボードからデプロイ |
| **CLI（npm スクリプト）** | `npm run deploy:public` | `npm run deploy:inhouse` |
| **バックエンド環境変数** | APP_DISTRIBUTION 未設定 または `public` | **APP_DISTRIBUTION=inhouse**（自社用の Render に設定） |

- **参照**: 共通の用語・考え方は `docs/PUBLIC_INHOUSE_APP_DEFINITION.md` を参照してください。
- **POS Stock の手順**: 同じ運用方針の詳細は `stock-transfer-pos/docs/DEPLOY_PUBLIC_AND_INHOUSE.md` を参照できます。

---

## 7. 管理画面でアプリを開くと何も表示されない（真っ白）場合

管理画面から「POS Receipt - Ciara」を開いたときに **真っ白** になる場合、次の環境変数を自社用 Render で確認してください。

| # | 確認項目 | 対処 |
|---|----------|------|
| 1 | **SHOPIFY_APP_URL** | **必須です。** `https://pos-receipt-ciara.onrender.com` に設定する。未設定や別 URL だと認証・リダイレクトが壊れ、iframe 内で何も表示されない。 |
| 2 | **SHOPIFY_API_KEY** | 自社用アプリの Client ID（`ec5374155070d767e71bbe5c258160e2`）になっているか。公開用の値のままなら認証失敗する。 |
| 3 | **SHOPIFY_API_SECRET** | パートナーで「POS Receipt - Ciara」の **Client secret** を取得し、ここに設定する。空や公開用の値だと認証できない。 |
| 4 | **DATABASE_URL** | PostgreSQL の接続文字列が正しいか。マイグレーション済みか（`npx prisma migrate deploy`）。セッション保存に DB を使うため、DB が使えないと認証が完了しない。 |
| 5 | パートナーのアプリ URL | 「POS Receipt - Ciara」の **アプリ URL** が `https://pos-receipt-ciara.onrender.com` になっているか。 |

**手順**: 上記を設定・修正したあと、Render で **再デプロイ**（Redeploy）してから、管理画面でアプリを開き直してください。

---

## 8. 管理画面で「401 Unauthorized」と表示される場合

埋め込みアプリで **401 Unauthorized** が出る主な原因は、**セッショントークンの検証失敗**です。管理画面の iframe から送られるトークンと、サーバーが持つ **SHOPIFY_API_SECRET** が一致していないと 401 になります。

| # | 確認項目 | 対処 |
|---|----------|------|
| 1 | **SHOPIFY_API_SECRET が自社用アプリのものか** | Render の環境変数には、必ず **「POS Receipt - Ciara」** の **Client secret**（クライアントの秘密鍵）を設定する。公開用「POS Receipt」の秘密鍵をそのままコピーしていないか確認する。パートナー → **POS Receipt - Ciara** → アプリの設定（または API 認証情報）→ **Client secret** をコピーし直し、Render の **SHOPIFY_API_SECRET** を上書きする。 |
| 2 | **SHOPIFY_API_SECRET の typo・余白** | 値をコピーするとき、前後にスペースや改行が入っていないか確認する。Render では値の前後の空白は基本的にトリムされるが、途中のスペースや改行は invalid になる。 |
| 3 | **ストアにインストールしているアプリ** | 管理画面で開いているのが **「POS Receipt - Ciara」** か確認する。ストアにインストールしているのが **公開用の「POS Receipt」** だと、トークンは公開用アプリの秘密鍵で署名されているため、自社用サーバー（Ciara の秘密鍵）では検証できず 401 になる。→ 自社用で使うストアには **POS Receipt - Ciara** をインストールし、管理画面ではそのアプリを開く。 |
| 4 | **環境変数反映後の再デプロイ** | **SHOPIFY_API_SECRET** や **SHOPIFY_API_KEY** を変更したあと、Render で **Redeploy** しないと反映されない。保存後に「Deploy latest commit」または「Clear build cache & deploy」を実行する。 |
| 5 | **SCOPES のスペース** | `SCOPES` は **カンマの前後にスペースを入れず** `read_orders,read_locations` にする。`read_orders, read_locations` のようにスペースが入っていると、スコープ検証で不整合になり 401 になることがある。 |

**確認の流れ**

1. パートナーダッシュボードで **「POS Receipt - Ciara」** を開く。
2. **API 認証情報**（またはアプリの設定）で **Client ID** と **Client secret** を確認する。Client ID が `ec5374155070d767e71bbe5c258160e2` であること。
3. その **Client secret** を Render の **SHOPIFY_API_SECRET** にそのまま貼り付ける（前後に余白を入れない）。
4. Render で **SHOPIFY_API_KEY** が `ec5374155070d767e71bbe5c258160e2` になっていることを確認する。
5. 保存 → **再デプロイ** → ストアの管理画面で **「POS Receipt - Ciara」** を開き直す。
