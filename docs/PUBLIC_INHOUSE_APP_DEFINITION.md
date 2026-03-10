# 公開用・自社用アプリの分離定義（共通）

同一コードベースで **公開用アプリ**（App Store 販売）と **自社用カスタムアプリ** の2種を運用するときの、責務・ファイル・環境変数・手順をまとめた共通定義です。  
**POS Stock（stock-transfer-pos）** の実装に基づき、POS Receipt や今後のアプリでも同じルールで揃えます。

---

## 1. 用語と役割

| 用語 | 意味 |
|------|------|
| **公開用** | App Store 等で一般販売するアプリ。別の Partner アプリ（別 client_id）として登録し、別のバックエンド URL にデプロイする。 |
| **自社用** | 自社店舗・グループ向けのカスタムアプリ。別の Partner アプリ（別 client_id）として登録し、自社用のバックエンド URL にデプロイする。 |
| **APP_MODE** | POS 拡張の **ビルド時** に参照する値。`"public"` なら公開用バックエンド URL、`"inhouse"` なら自社用バックエンド URL を指す。 |
| **APP_DISTRIBUTION** | バックエンド（Node サーバー）の **環境変数**。`inhouse` のときはプラン制限なし（全機能解放）、未設定 or `public` のときは Billing API でプラン判定。 |

---

## 2. 設定ファイルの対応

| 種別 | 使用する toml | バックエンド URL 例（POS Stock） | バックエンド URL 例（POS Receipt） |
|------|----------------|----------------------------------|------------------------------------|
| **公開用** | `shopify.app.public.toml` | https://pos-stock.onrender.com | （例: https://pos-receipt.onrender.com） |
| **自社用** | `shopify.app.toml` | https://stock-transfer-pos.onrender.com | （例: https://pos-receipt-ciara.onrender.com） |

- 各 toml の **client_id** は、パートナーで作成した「公開用」「自社用」それぞれのアプリの Client ID を設定する。
- **application_url** と **redirect_urls** は、そのアプリ用にデプロイするバックエンドの URL にする。

---

## 3. POS 拡張側（extensions）：APP_MODE と appUrl.js

### 3.1 責務

- POS タイル等が API を呼ぶ **ベース URL** を、**ビルド時に** 決める。
- 公開用にデプロイするビルドでは「公開用 URL」、自社用にデプロイするビルドでは「自社用 URL」を参照する必要がある。

### 3.2 実装パターン（POS Stock と同じ）

- **共通モジュール**を置く: `extensions/common/appUrl.js`
- 中で **APP_MODE** を 1 箇所定義する（`"public"` または `"inhouse"`）。
- 本番用 URL を APP_MODE で分岐して定義し、**getAppUrl()** で返す。
- 各 POS 拡張では、API 呼び出し時に `getAppUrl()` を使ってベース URL を取得する。

```js
// extensions/common/appUrl.js のイメージ
const APP_MODE = "public"; // または "inhouse"

const PROD_APP_URL_PUBLIC = "https://pos-receipt.onrender.com";
const PROD_APP_URL_INHOUSE = "https://pos-receipt-ciara.onrender.com";

const PROD_APP_URL = APP_MODE === "inhouse" ? PROD_APP_URL_INHOUSE : PROD_APP_URL_PUBLIC;

export function getAppUrl(useDev = false) {
  return useDev ? DEV_APP_URL : PROD_APP_URL;
}
```

### 3.3 ルール

- **公開用にデプロイするとき** → デプロイ前に `APP_MODE = "public"` にしておく。
- **自社用にデプロイするとき** → デプロイ前に `APP_MODE = "inhouse"` にしておく。
- デプロイは「どちらのアプリにデプロイするか」と「その時点の APP_MODE」が一致している必要がある。

---

## 4. バックエンド側（app/）：APP_DISTRIBUTION

### 4.1 責務

- そのサーバーが「公開用」として動いているか「自社用」として動いているかを **環境変数** で判定する。
- **自社用** のときはプラン・課金をスキップし、全機能を解放する。

### 4.2 環境変数

| 変数名 | 設定する場所 | 値 | 意味 |
|--------|--------------|-----|------|
| **APP_DISTRIBUTION** | Render 等のバックエンド環境変数 | `inhouse` | このサーバーは自社用。プラン制限なし・全機能解放。 |
| **APP_DISTRIBUTION** | 同上 | 未設定 または `public` | このサーバーは公開用。Billing API でスタンダード/プロを判定し、機能を制限する。 |

- 大文字小文字は揃えておく（実装では `trim().toLowerCase()` で `inhouse` と比較する想定）。

### 4.3 判定ロジック（POS Stock の app.tsx と同じ考え方）

```ts
// 疑似コード
const distEnv = (process.env.APP_DISTRIBUTION ?? "").trim().toLowerCase();
const distribution = distEnv === "inhouse" ? "inhouse" : "public";

// オプション: 公開用 1 本のデプロイで、特定ストアだけ全機能にしたい場合
const customStoreIds = (process.env.CUSTOM_APP_STORE_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
const forceInhouse = currentShop && customStoreIds.includes(currentShop.toLowerCase());
const distribution = (distEnv === "inhouse" || forceInhouse) ? "inhouse" : "public";
```

- **distribution === "inhouse"** のとき: プランは常に「Pro 相当」として扱い、有料機能をすべて ON にする。
- **distribution === "public"** のとき: `currentAppInstallation.activeSubscriptions` 等からプランを取得し、スタンダード/プロに応じて機能を制御する。

### 4.4 オプション: CUSTOM_APP_STORE_IDS

- **公開用の URL 1 本** しか運用しないが、特定のストア（自社ストア）だけ「自社用と同様に全機能」にしたい場合に使う。
- 環境変数 **CUSTOM_APP_STORE_IDS** に、そのストアのドメインをカンマ区切りで指定する（例: `my-store.myshopify.com,other.myshopify.com`）。
- 現在のショップがこのリストに含まれるときは、`APP_DISTRIBUTION` が `public` でも **inhouse 扱い** にして全機能解放する。
- 自社用専用のデプロイ（別 URL）で **APP_DISTRIBUTION=inhouse** を設定している場合は、CUSTOM_APP_STORE_IDS は不要。

---

## 5. デプロイ時の切り替え

### 5.1 APP_MODE の書き換え

- 手で `extensions/common/appUrl.js` の `APP_MODE` を書き換えてもよい。
- **スクリプトで揃える場合**（POS Stock と同じ）:
  - `scripts/set-app-mode.js` を用意し、`node scripts/set-app-mode.js public` または `node scripts/set-app-mode.js inhouse` で **appUrl.js の APP_MODE だけ** を書き換える。
  - 正規表現で `const APP_MODE = "(?:public|inhouse)";` を、指定した値に置換する。

### 5.2 npm スクリプト（推奨）

```json
"deploy:public": "node scripts/set-app-mode.js public && shopify app config use shopify.app.public.toml && shopify app deploy --force",
"deploy:inhouse": "node scripts/set-app-mode.js inhouse && shopify app config use shopify.app.toml && shopify app deploy --force"
```

- **deploy:public**: APP_MODE を public に書き換え → 公開用 toml を有効化 → `shopify app deploy`。
- **deploy:inhouse**: APP_MODE を inhouse に書き換え → 自社用 toml を有効化 → `shopify app deploy`。
- 実行後、ディスク上の appUrl.js は「最後に実行した deploy」のモードになる。次に別方をデプロイするときは、もう一方のスクリプトを実行すればよい。

### 5.3 パートナーダッシュボードからデプロイする場合

- デプロイする **アプリ**（公開用 or 自社用）に合わせて、**プッシュ時点の APP_MODE** を合わせる。
- 公開用にデプロイする → APP_MODE = "public" の状態でコミット・プッシュ → **公開用アプリ** のダッシュボードからデプロイ。
- 自社用にデプロイする → APP_MODE = "inhouse" の状態でコミット・プッシュ → **自社用アプリ** のダッシュボードからデプロイ。

---

## 6. まとめ表（共通で揃えるもの）

| 項目 | 公開用 | 自社用 |
|------|--------|--------|
| **toml** | `shopify.app.public.toml` | `shopify.app.toml` |
| **APP_MODE（appUrl.js）** | `"public"` | `"inhouse"` |
| **バックエンド環境変数 APP_DISTRIBUTION** | 未設定 or `public` | `inhouse` |
| **プラン・課金** | Billing API でスタンダード/プロを判定 | 制限なし（全機能 Pro 相当） |
| **デプロイ（CLI）** | `npm run deploy:public` | `npm run deploy:inhouse` |

---

## 7. 参照元（POS Stock）

- **デプロイ手順**: `stock-transfer-pos/docs/DEPLOY_PUBLIC_AND_INHOUSE.md`
- **APP_MODE 書き換え**: `stock-transfer-pos/scripts/set-app-mode.js`
- **appUrl 定義**: `stock-transfer-pos/extensions/common/appUrl.js`
- **appUrl 利用例**: `stock-transfer-pos/extensions/common/README.md`
- **バックエンドの distribution 判定**: `stock-transfer-pos/app/routes/app.tsx` の `getShopPlan`（`APP_DISTRIBUTION` と `CUSTOM_APP_STORE_IDS`）

POS Receipt や他アプリで「公開用・自社用を分ける」ときは、上記と同じルールで toml・appUrl.js・環境変数・deploy スクリプトを用意すると、運用を共通化できます。
