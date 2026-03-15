# 「読み込みに失敗しました。接続先と認証を確認してください。」の対処

このメッセージは **API の呼び出しが失敗している**ときに出ます。接続先（URL）と認証（トークン・環境変数）を順に確認してください。

---

## 修正済み: 認証失敗時の CORS（管理画面は開けるが POS だけ失敗する場合）

**原因**: Shopify の `authenticate.pos(request)` は、トークンがない・無効のときに **CORS ヘッダーなしの 401 Response** を throw します。POS は別オリジン（cdn.shopify.com 等）から API を呼ぶため、CORS がないとブラウザがレスポンスをブロックし、クライアント側では「読み込みに失敗しました」のように見えます。管理画面は同一オリジンに近いため問題になりません。

**対応**: `app/utils/posAuth.server.ts` に以下を追加済みです。

- **authenticatePosRequestOrCorsError(request)** … 認証を試し、失敗時は **CORS 付き**のエラーレスポンスを返す。全 POS API ルートでこちらを使用。
- **corsErrorJson(request, data, status)** … catch 内で CORS 付き JSON エラーを返すためのヘルパー。

これにより、401 や 500 でも POS からレスポンス本体を読めるようになり、必要なら「認証に失敗しました」などのメッセージが表示されます。**本番デプロイ後、POS で再度タイルを開いて動作を確認してください。**

---

## 0. まだ「接続先と認証を確認してください」と出るときの確認（最新）

### 0.1 表示を確認する

エラー文の**末尾**に **`(HTTP 4xx)` や `(HTTP 5xx)` が付いているか**を見てください。

| 表示例 | 意味 |
|--------|------|
| **…認証を確認してください。 (HTTP 401)** | リクエストはサーバーに届いているが**認証で失敗**。トークン未送信・無効・アプリ不一致の可能性。 |
| **…認証を確認してください。 (HTTP 500)** | サーバーまで届いているが**サーバー側エラー**。ログや DB 接続を確認。 |
| **…認証を確認してください。**（HTTP の記載なし） | サーバーに**届いていない**可能性（URL 違い・ネットエラー・CORS でブロックなど）。 |

### 0.2 接続だけ先に確かめる（認証不要）

次の URL を**ブラウザ**で開いてください。**既存の api.locations ルート**を使うため、デプロイしていれば 404 になりません。

- 本番: **`https://pos-receipt.onrender.com/api/locations?ping=1`**
- 自社用: **`https://pos-receipt-ciara.onrender.com/api/locations?ping=1`**

**期待する結果**:  
`{"ok":true,"message":"POS API is reachable","method":"GET"}` が表示される。

- **表示される** → サーバーは起動しており、その URL には届く。POS 側は「認証」か「POS からだけ届かない事象」を疑う。
- **404** → 上記の「?ping=1 対応」を入れた変更がまだデプロイされていない。コードを push して Render で再デプロイする。
- **表示されない・タイムアウト** → 接続先 URL やネットワーク・デプロイ状態を確認する。

※ 別途 `GET /api/pos-ping` も用意してあるが、そのルート（api.pos-ping.tsx）が本番に含まれていないと 404 になる。その場合は上記 `?ping=1` を使う。

### 0.3 認証まわり（401 が出る場合）

- ストアにインストールしているアプリ（公開用 / 自社用）と、そのサーバーの **SHOPIFY_API_KEY**・**SHOPIFY_API_SECRET** が一致しているか。
- POS アプリを**完全に終了してから開き直し**、タイルを再度開く（トークン再取得のため）。

---

## 1. いま「開発モード」か「本番」か

| 状況 | 拡張が叩く URL（目安） | 確認するサーバー |
|------|------------------------|------------------|
| **`shopify app dev` で開いている** | トンネル or 本番（後述） | トンネル or Render |
| **本番デプロイしたアプリを開いている** | `appUrl.js` の PROD_APP_URL | Render（公開用 or 自社用） |

**重要**: POS 拡張は **ビルド時に** `extensions/common/appUrl.js` の `APP_MODE` と、実行時に `window.location.origin` が取れるかで URL を決めています。  
POS の実行環境では `window` が無いことがあり、その場合は **常に本番 URL**（`pos-receipt.onrender.com` または `pos-receipt-ciara.onrender.com`）にリクエストが飛びます。

- **開発モードで開いているのに本番 URL に飛んでいる** → 本番の Render が「今ログインしているストア・アプリ」のトークンを正しく検証しているかがポイントです。
- **本番で開いている** → 使っている Render の環境変数と、インストールしているアプリが一致しているかがポイントです。

---

## 2. 接続先の確認（どこにリクエストが飛んでいるか）

### 2.1 管理画面では動くか

1. ブラウザで **Shopify 管理画面** を開く。
2. **アプリ** → **POS Receipt**（または POS Receipt - Ciara）を開く。
3. ホームや設定が普通に表示され、エラーが出ないか確認する。

- **管理画面は開ける** → そのストア・アプリに対するバックエンド（同じ SHOPIFY_APP_URL のサーバー）は動いています。  
  → POS 側は「**別の URL に飛んでいる**」か「**トークンの扱いの違い**」が疑われます。
- **管理画面も開けない・エラー** → まずそのバックエンド（Render の URL・環境変数・デプロイ）を確認してください。

### 2.2 開発モードでどちらの URL に飛ぶか

- `shopify app dev` で起動したとき、拡張の配信元は **トンネル**（例: `https://xxxx.ngrok.io`）です。
- 一方で、拡張内の `getAppUrl()` は **POS 上では `window` が無く、本番 URL を返す**ことがあります。
- その場合、**POS からの API は本番の Render に届きます**。  
  → 開発中でも「本番の Render（pos-receipt.onrender.com など）の環境変数と、今開いているアプリが一致しているか」を確認する必要があります。

---

## 3. 認証の確認（401 にならないようにする）

次の **3 つが一致している**必要があります。

| 項目 | 内容 |
|------|------|
| **ストアにインストールしているアプリ** | 例: 公開用「POS Receipt」 or 自社用「POS Receipt - Ciara」 |
| **そのアプリの Client ID（API Key）** | パートナー → 該当アプリ → クライアント ID |
| **API を処理するサーバーの環境変数** | そのアプリ用の `SHOPIFY_API_KEY` と `SHOPIFY_API_SECRET` |

**よくあるミス**:

- 開発ストアに「POS Receipt」（公開用）を入れているのに、Render には自社用の `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` を入れている（またはその逆）。
- `SHOPIFY_APP_URL` が違う（例: 自社用サーバーなのに `https://pos-receipt.onrender.com` のまま）。

### 3.1 確認手順（Render の場合）

1. **どのアプリで開いているか**  
   管理画面で「アプリ」から開いているのが「POS Receipt」か「POS Receipt - Ciara」か確認する。
2. **そのアプリの認証情報**  
   パートナー → そのアプリ → 設定（API 認証情報）で **Client ID** と **Client secret** を確認する。
3. **Render の環境変数**  
   - `SHOPIFY_API_KEY` ＝ 上記 **Client ID** と一致しているか  
   - `SHOPIFY_API_SECRET` ＝ 上記 **Client secret** と一致しているか  
   - `SHOPIFY_APP_URL` ＝ その Render の URL（例: `https://pos-receipt.onrender.com` または `https://pos-receipt-ciara.onrender.com`）になっているか  
4. **変更したら再デプロイ**  
   環境変数を変えたら、Render で「Clear build cache & deploy」などで再デプロイする。

---

## 4. 開発モードで「必ずトンネルに飛ばしたい」場合

POS 上では `window.location.origin` が取れず本番 URL に飛ぶため、**開発時だけ**トンネルに固定したい場合は、次のような運用が考えられます。

1. **開発用に appUrl.js を一時変更する**  
   - `getAppUrl()` が開発用のトンネル URL を返すように、先頭で固定で返す。  
   - 例: `return "https://xxxx.ngrok.io";`（`shopify app dev` のターミナルに表示される URL に合わせる）  
   - 注意: トンネル URL は起動のたびに変わる場合があるので、そのたびに書き換えが必要。
2. **開発時だけ同じマシンでバックエンドを立て、トンネル経由でアクセスできるようにする**  
   - `shopify app dev` は通常、バックエンドもトンネル経由で公開するので、上記 1 の URL をトンネルに合わせれば、POS からも同じバックエンドに届けられます。
3. **開発中は本番 URL のままにして、本番の Render の認証を合わせる**  
   - 開発ストアに「POS Receipt」（公開用）を入れ、本番の Render（pos-receipt.onrender.com）の `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` をその公開用アプリの値にしておく。  
   - これで POS が本番 URL に飛んでも、同じアプリのトークンなので 401 にならない可能性があります。

---

## 5. チェックリスト（コピーして使う）

- [ ] 管理画面で同じアプリを開くと正常に表示されるか
- [ ] 今開いているストアにインストールしているアプリ名（公開用 / 自社用）を確認した
- [ ] そのアプリの Client ID と Render の `SHOPIFY_API_KEY` が一致している
- [ ] そのアプリの Client secret と Render の `SHOPIFY_API_SECRET` が一致している
- [ ] Render の `SHOPIFY_APP_URL` が、その Render の URL になっている
- [ ] 環境変数変更後に Render を再デプロイした
- [ ] （開発モードの場合）拡張が本番 URL に飛んでいる前提で、上記を満たしているか確認した

---

*「読み込みに失敗しました。接続先と認証を確認してください。」は、API が 401 / 500 / ネットワークエラーなどで失敗したときに表示されます。上記で接続先と認証を揃えれば解消することが多いです。*
