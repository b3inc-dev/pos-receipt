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

**本番サーバー（Render など）**: `npm run start` は **`node server.js`** を実行します。このカスタムサーバーが POS からの CORS プリフライト（OPTIONS）を処理するため、Render の Start Command はそのままで問題ありません。

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
3. その **Client secret** を Render の **SHOPIFY_API_SECRET** にそのまま貼り付ける（前後に余白を入れない）。**再発行で「シークレット 旧」と「シークレット 新規」の2つある場合は、必ず「新規」の方をコピーして使う。** 旧のままでは 401 になる。
4. Render で **SHOPIFY_API_KEY** が `ec5374155070d767e71bbe5c258160e2` になっていることを確認する。
5. 保存 → **再デプロイ** → ストアの管理画面で **「POS Receipt - Ciara」** を開き直す。

### それでも 401 が続く場合：Client secret を再発行して差し替える

トークンの **aud** が自社用アプリの Client ID（`ec5374155070d767e71bbe5c258160e2`）になっているのに 401 になる場合は、**サーバーが持っている秘密鍵と、トークン署名に使われた秘密鍵が一致していない**状態です。次の手順で秘密鍵を「再発行 → 即反映」すると確実に揃えられます。

1. パートナー → **POS Receipt - Ciara** → **設定**（または **API 認証情報**）。
2. **Client secret** の **「再発行」** または **「Regenerate」** を実行する。
3. 表示された **新しい Client secret** をコピーする（この画面を閉じると二度と表示されないので、すぐに Render に貼る）。
4. Render → 自社用 Web サービス → **Environment** → **SHOPIFY_API_SECRET** の値を、今コピーした**新しい秘密鍵**で上書きする。
5. **Save Changes** のあと、**Manual Deploy** → **Clear build cache & deploy**（または **Deploy latest commit**）で再デプロイする。
6. デプロイ完了後、管理画面で **「POS Receipt - Ciara」** を開き直す（必要ならブラウザのキャッシュを無効にして再読み込み）。

※ 再発行すると**古い秘密鍵は使えなくなる**ため、公開用の Render や他環境で同じアプリの秘密鍵を使っている場合は、そちらも同じ新しい値に更新してください。今回は自社用（Ciara）だけなので、自社用 Render だけ更新すれば問題ありません。

### サーバー側で秘密鍵をトリムする（実装済み）

環境変数に**改行やスペース**が混ざっていると JWT 検証で 401 になります。アプリでは `SHOPIFY_API_KEY` と `SHOPIFY_API_SECRET` を **trim** してから Shopify に渡すようにしています。それでも 401 になる場合は、Render の環境変数入力欄で値の前後や途中に改行が入っていないか確認してください。

### 401 デバッグ用エンドポイント（/env-check）

サーバーが実際に読み込んでいる環境変数の状態を、**認証なし**で確認できます。401 のときだけ一時的に使ってください。

- **URL**: `https://pos-receipt-ciara.onrender.com/env-check`
- **返す内容**: `SHOPIFY_API_KEY` の先頭 8 文字・長さ・期待値との一致、`SHOPIFY_API_SECRET` の設定有無・長さ、`SHOPIFY_APP_URL` の有無（値そのものは返しません）。
- **確認ポイント**:
  - `SHOPIFY_API_KEY.prefix` が `ec537415` かつ `match: true` になっているか。
  - `SHOPIFY_API_SECRET.length` が 0 でないか（通常 32 文字前後）。0 なら未設定、31/33 などなら typo や改行の可能性。
- 原因を特定したあとは、このルート（`app/routes/env-check.tsx`）を削除するか無効化してください。

### SHOPIFY_API_SECRET の長さについて

`shpss_` で始まる **38 文字**（shpss_ + 32 文字）は Shopify の Client secret の正しい形式です。32 文字でないからといって誤りではありません。

### 秘密鍵が正しいのに 401 が続く場合の他の要因

環境変数（KEY・SECRET・APP_URL）が正しく、空白・改行もないのに 401 になる場合は、次を順に試してください。

| # | 要因 | 対処 |
|---|------|------|
| 1 | **古いセッショントークン** | 秘密鍵を再発行したあと、**ブラウザ側に古いトークン**が残っていると検証に失敗することがあります。→ **ストアでアプリを一度アンインストールし、再度インストール**する。またはシークレットウィンドウで管理画面にログインし直してからアプリを開く。 |
| 2 | **トークン交換（token exchange）の失敗** | JWT の検証は通るが、そのあと Shopify の「トークン交換」API が失敗し 401 になる場合があります。→ Render の **Logs** で、401 が出た直前に `InvalidJwtError` や `invalid_subject_token` などのメッセージが出ていないか確認する。 |
| 3 | **パートナー側のアプリ URL の不一致** | パートナーで「POS Receipt - Ciara」の **アプリ URL** が `https://pos-receipt-ciara.onrender.com` と完全一致しているか確認する。末尾のスラッシュの有無や、別ドメインになっていないか。 |
| 4 | **スコープ不足** | アプリのスコープと、インストール時に許可したスコープが一致しているか。パートナーで **read_orders, read_locations** が設定されており、ストアでアプリを再インストールしてスコープを再度許可し直す。 |
| 5 | **Render のログで原因を特定** | 401 が返るリクエストの前後で、Render の **Logs** に `Failed to validate session token` や `InvalidJwtError` などの出力があれば、JWT 検証失敗。`invalid_subject_token` などならトークン交換の失敗。エラー内容を確認してから次の対策を取る。 |

### 重要: Webhook も 401 なら秘密鍵の不一致がほぼ確定

**POST /webhooks/app/uninstalled** が **401** になっている場合、Webhook の HMAC 検証も失敗しています。Webhook と管理画面のセッションは**同じ SHOPIFY_API_SECRET** で検証されるため、**サーバー側の秘密鍵が Shopify 側（そのアプリ）の秘密鍵と一致していない**可能性が非常に高いです。

- **ありがちな原因**: パートナーで **別のアプリ**（例: 公開用「POS Receipt」）の Client secret をコピーして、自社用（POS Receipt - Ciara）の Render に設定している。Client ID は Ciara のものにしているが、Secret だけ公開用のまま、という組み合わせ。
- **確認**: パートナーで **Client ID が `ec5374155070d767e71bbe5c258160e2` のアプリ** を開き、**その同じ画面**の「Client secret」をコピーしているか確認する。アプリ名ではなく、**必ず Client ID でどちらのアプリか判別**する。

### 切り分け: 新しいカスタムアプリで検証する

「秘密鍵は正しくコピーしている」のに 401 が続く場合、**新しいカスタムアプリを 1 つだけ作り、その認証情報だけで動かす**と原因を切り分けられます。

1. パートナー → **アプリ** → **アプリを作成** → **カスタムアプリを作成**。名前は仮でよい（例: POS Receipt Ciara Test）。
2. 作成したアプリの **Client ID** と **Client secret** を控える。**アプリ URL** を `https://pos-receipt-ciara.onrender.com` に設定する。
3. `shopify.app.toml` の **client_id** を、この新しいアプリの Client ID に差し替える（一時的）。
4. Render の **SHOPIFY_API_KEY** と **SHOPIFY_API_SECRET** を、この新しいアプリの値に差し替える。
5. 保存 → **再デプロイ**。
6. ストアで **いったん現在の「POS Receipt - Ciara」をアンインストール**し、**新しく作ったテスト用アプリをインストール**する（パートナーから「ストアを選択してインストール」など）。
7. 管理画面でそのテスト用アプリを開く。

- **ここで 200 になる** → 以前使っていたアプリの秘密鍵が、サーバーに設定したものと一致していなかった（別アプリのものをコピーしていた、または再発行後に更新していない、など）。
- **ここでも 401** → 秘密鍵のコピーミスや Render の設定ミス、あるいはライブラリ側の挙動を疑う必要がある。

---

## 他アプリ（POS Stock）との設定の違いチェックリスト

401 の要因が「Render の設定だけか？」を切り分けるため、**動作している自社用アプリ（POS Stock - Ciara）** と **POS Receipt - Ciara** の設定を揃えられる箇所をまとめます。

| 項目 | POS Stock（自社用・動作例） | POS Receipt（自社用） | 備考 |
|------|-----------------------------|------------------------|------|
| **shopify.app.toml** | | | |
| `[access.admin]` | あり（direct_api_mode, embedded_app_direct_api_access） | **追加済み**（上記と同様） | 埋め込みアプリのトークンまわり。401 の直接原因ではないが、他アプリと揃えるために追加推奨。 |
| `[auth] redirect_urls` | 自社用 URL 1 件 | 自社用 URL 1 件 | 一致していれば問題なし。 |
| **app（コード）** | | | |
| `shopify.server.ts` の apiKey / apiSecretKey | 生の `process.env` | **trim 済み**（コピペミス対策） | trim は秘密鍵を壊さない。POS Stock は trim なしでも動いている。 |
| `distribution`（AppDistribution） | `AppDistribution.AppStore` を指定 | 未指定 | 自社用では未指定でよい。公開用のプラン制御用。 |
| **Render（環境変数）** | | | |
| SHOPIFY_API_KEY | 自社用アプリの Client ID | 自社用アプリの Client ID（ec53...） | **必ずそのアプリの値**。別アプリの KEY にすると 401。 |
| SHOPIFY_API_SECRET | 自社用アプリの Client secret | 自社用アプリの Client secret | **必ずそのアプリの値**。ここが違うと Webhook も管理画面も 401。 |
| SHOPIFY_APP_URL | 自社用の URL | 自社用の URL | 一致していること。 |
| **パートナー側** | | | |
| アプリ URL | 自社用 Render の URL | 自社用 Render の URL | 一致していること。 |
| Client ID / Secret の取得元 | 自社用アプリの画面 | **Client ID が ec53... のアプリの画面**で Secret も取得しているか要確認。 |

**結論**: コードや toml の差で 401 になるより、**Render の SHOPIFY_API_SECRET が「そのアプリの秘密鍵」と一致していない**可能性が最も高いです。Webhook も 401 のため、サーバー側の秘密鍵が Shopify 側と一致していないと判断できます。上記の「切り分け: 新しいカスタムアプリで検証する」で、新しいアプリの認証情報だけを設定して試すと原因を特定しやすくなります。
