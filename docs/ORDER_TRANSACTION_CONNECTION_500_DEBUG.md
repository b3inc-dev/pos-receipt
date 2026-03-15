# 「Field `id` doesn't exist on type 'OrderTransactionConnection'」(HTTP 500) の切り分け

この 500 は、**精算プレビューで叩いている API を処理しているサーバー**が、まだ古い GraphQL クエリ（`transactions { id ... }`）を使っているときに発生します。  
どこが原因か切り分ける手順です。

## 原因（技術メモ）

Shopify Admin API の `Order.transactions` と `Order.refunds` は **Connection 型**（`OrderTransactionConnection` / `OrderRefundConnection`）です。Connection 型には `id` はなく、**`edges { node { id ... } }`** で中身を取得する必要があります。`nodes { id ... }` は API バージョンによってはサポートされず、その場合も同様のエラーになります。そのため、本アプリでは **`edges { node { ... } }`** 形式に統一しています（`settlementEngine.server.ts` と `api.orders.$orderId.tsx`）。

**関連:** Order 型にロケーションを取る場合は **`location` ではなく `retailLocation`** を使います（`location` は Order に存在せず "Field 'location' doesn't exist on type 'Order'" になる）。領収書・注文検索・注文詳細で `retailLocation { id name }` に統一済み。

---

## 0. アプリタイル上で確認する（いちばん手軽）

### 精算プレビューを押したとき（失敗時に自動で切り分け表示）

**精算プレビュー** を押してエラーになった場合、**同じ画面のエラー直下** に「原因の切り分け」が自動で表示されます。

- **接続先** … プレビューで叩いた API のベース URL。
- **GraphQL修正済み** … 確認中… → **はい** / **いいえ**。**いいえ** のときは「→ このサーバーを再デプロイすると解消します。」と表示されます。

別途ボタンを押さなくても、プレビュー失敗時に **どのサーバーが原因か** と **再デプロイで直るか** がその場で分かります。

### 事前に接続状態だけ確認したいとき

精算タイルを開いたときの **メイン画面** に **「接続・バージョン確認」** ボタンがあります。

1. POS で **精算** タイルを開く。
2. **「接続・バージョン確認」** をタップする。
3. 表示される内容を確認する。
   - **接続先** … いま API を呼んでいるベース URL（開発トンネル or 本番）。
   - **応答** … OK / エラー。
   - **GraphQL修正済み** … **はい** ならそのサーバーは修正済み。**いいえ** ならそのサーバーが古く、500 の原因。

**「GraphQL修正済み: いいえ」** のときは、表示される案内に従ってください。接続先が **開発用URL**（トンネル・localhost）なら「開発サーバーを再起動」、**本番URL**（Render）なら「本番を再デプロイ」と出し分けています。

### 再デプロイしたのにずっと「GraphQL修正済み: いいえ」のとき

「デプロイしたのに切り分けがデプロイ以外の問題では？」と感じる場合、次で本当に最新コードが動いているか確認してください。

1. **ブラウザで ping の応答を直接確認する**  
   接続先の URL に `/api/locations?ping=1` を付けて開く（例: `https://pos-receipt.onrender.com/api/locations?ping=1`）。  
   - **`graphqlTransactionsUseNodes: true` と `diagnosticVersion: "2025-03-graphql-nodes"` が JSON に出ている**  
     → そのサーバーは修正済み。POS 側のキャッシュや別の接続先を疑う。  
   - **出ていない / 404・500・HTML が返る**  
     → 本番でまだ古いコードが動いているか、ビルドが失敗している。

2. **Render で「Clear build cache & deploy」を実行する**  
   通常の「Deploy」だけだとキャッシュで古いビルドが使われることがあります。

3. **Render の「Start Command」が `node server.js` か確認する**  
   `package.json` の `start` が `node server.js` になっていれば OK。

4. **開発環境で「GraphQL修正済み: いいえ」と出る場合**  
   接続先がトンネル・localhost なら、案内は「開発サーバーを再起動」になります。デプロイの案内は本番（Render）向けだけに表示されます。

---

## 1. どこのサーバーにリクエストが行っているか確認する

「精算プレビュー」を押したときに、**どの URL に POST が飛んでいるか**で原因が変わります。

### 方法 A: ブラウザの開発者ツールで確認（推奨）

1. 管理画面を **Chrome など** で開く。
2. **F12** で開発者ツールを開き、**Network（ネットワーク）** タブを開く。
3. フィルターを **Fetch/XHR** にする。
4. **POS を開き、精算タイル → 精算プレビュー** を実行する。
5. 一覧に出た **`preview` や `settlements/preview`** のようなリクエストをクリックする。
6. **Headers** の **Request URL** を確認する。

| Request URL の例 | 意味 |
|------------------|------|
| `https://xxxx.ngrok.io/api/settlements/preview` や `http://localhost:3000/api/...` | **開発サーバー**（トンネル or localhost）に飛んでいる。 |
| `https://pos-receipt.onrender.com/api/settlements/preview`（または pos-receipt-ciara.onrender.com） | **本番（Render）** に飛んでいる。 |

- **Render の URL になっている** → いま動いているのは本番。本番に修正がデプロイされていなければ 500 のまま。**push して Render を再デプロイ**すれば解消する。
- **トンネル or localhost** になっている → 開発サーバーが古いコードの可能性。次の「2」でそのサーバーが修正済みか確認する。

### 方法 B: 診断用 ping で「修正済みか」だけ確認する

「このサーバーは OrderTransactionConnection を `nodes` で取る修正が入っているか」を、**GET リクエスト 1 本**で確認できます。

**確認したいサーバーのベース URL** に対して、次の URL をブラウザで開くか、`curl` する。

```
（ベースURL）/api/locations?ping=1
```

例:

- 開発（トンネル）: `https://xxxx.ngrok.io/api/locations?ping=1`
- 開発（localhost）: `http://localhost:3000/api/locations?ping=1`
- 本番: `https://pos-receipt.onrender.com/api/locations?ping=1`

**返ってきた JSON を見る:**

| レスポンスの内容 | 意味 |
|------------------|------|
| `graphqlTransactionsUseNodes: true` が **ある** | そのサーバーには **修正済みコード**（transactions/refunds を `nodes` で取得）が入っている。 |
| `graphqlTransactionsUseNodes` が **ない** | そのサーバーは **古いコード** のまま。500 の原因はここ。 |

- **本番 URL で ping したら `graphqlTransactionsUseNodes` がない**  
  → 本番が古い。**push → Render で再デプロイ** する。
- **開発 URL（トンネル or localhost）で ping したら `graphqlTransactionsUseNodes` がない**  
  → 開発で動かしているサーバーが古い。**`npm run dev:clean` でクリーンビルドしてから `npm run dev`** し直す。
- **開発 URL では `graphqlTransactionsUseNodes: true` があるのに、精算プレビューは本番 URL に飛んでいる**  
  → POS が本番を叩いている。**「表示されたプレビュー用 URL からだけ」管理画面・POS を開く**と開発サーバーに向く。

---

## 2. 切り分けの流れ（まとめ）

```
精算プレビューで 500 が出る
    │
    ▼
Network で Request URL を確認
    │
    ├─ 本番（Render）の URL
    │      │
    │      ▼
    │  本番で /api/locations?ping=1 を開く
    │      │
    │      ├─ graphqlTransactionsUseNodes がない
    │      │     → 本番が古い → push して Render を再デプロイ
    │      │
    │      └─ graphqlTransactionsUseNodes: true がある
    │            → 本番は修正済み。別原因（キャッシュや別ルート）を疑う。
    │
    └─ 開発（トンネル or localhost）の URL
           │
           ▼
      開発で /api/locations?ping=1 を開く（同じベース URL）
           │
           ├─ graphqlTransactionsUseNodes がない
           │     → 開発サーバーが古い → npm run dev:clean してから npm run dev
           │
           └─ graphqlTransactionsUseNodes: true がある
                 → 開発は修正済み。500 の詳細（別 API や Shopify のエラー）を確認。
```

---

## 3. よくあるパターン

| 状況 | 原因 | やること |
|------|------|----------|
| POS を「ストアの管理画面」の通常 URL で開いている | 拡張や API が本番（Render）を参照している | 開発時は **`shopify app dev` が表示するプレビュー用 URL からだけ** 開く。または本番を直すなら **push → Render 再デプロイ**。 |
| 本番の ping に `graphqlTransactionsUseNodes` がない | Render にまだ修正がデプロイされていない | 修正を push し、Render で「Deploy latest commit」または自動デプロイを実行。 |
| 開発の ping に `graphqlTransactionsUseNodes` がない | 開発で古いビルドやキャッシュが使われている | `npm run dev:clean` でキャッシュ削除・ビルドし直し → `npm run dev`。 |

この手順で「どこが古いか」を切り分けたうえで、該当するサーバー（開発 or 本番）を修正版で動かし直すと、500 の原因を確実に絞り込めます。
