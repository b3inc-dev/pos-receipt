# 「This app is not approved to access the Order object」(HTTP 500) の対処

領収書の「取引を選択」や注文検索で、注文（Order）にアクセスした際にこのメッセージが出る場合の対処です。

## 公式情報

- [Protected customer data（保護された顧客データ）](https://shopify.dev/docs/apps/launch/protected-customer-data)  
  Order は顧客に関連する保護データに含まれるため、アプリが Order にアクセスするには **アクセス承認** が必要な場合があります。

## やること

1. **スコープの確認**  
   `shopify.app.toml` の `[access_scopes]` に **`read_orders`** が含まれているか確認してください。含まれている場合でも、ストア側でアプリを再インストールし直し、スコープを再度許可してもらうと解消することがあります。

2. **Partner Dashboard で Order アクセスを申請**  
   手順の詳細は下記「Partner Dashboard での申請手順」を参照してください。  
   開発ストアのみで使うアプリの場合は、申請後すぐに開発ストアではアクセスできる場合があります。

3. **アプリの再インストール**  
   ストアで一度アプリをアンインストールし、再度インストールしてスコープ（`read_orders` 等）を改めて許可してもらう。

## 参照の仕方が公式かどうか

- 注文の取得は **GraphQL Admin API** の [Order](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order) および [orders クエリ](https://shopify.dev/docs/api/admin-graphql/latest/queries/orders) を使用しており、公式の型・フィールドに沿っています。
- 領収書・精算で必要な範囲（`id`, `name`, `totalPriceSet`, `customer`, `retailLocation`, `lineItems`, `transactions`, `refunds` など）は、いずれも Admin API の Order オブジェクトの公式フィールドです。

エラーが「権限・承認」に関するメッセージの場合は、上記の承認フローと再インストールを試してください。

---

## Partner Dashboard での申請手順（Order アクセス）

Order（注文）は「保護された顧客データ」に含まれるため、Partner Dashboard で **Protected customer data** のアクセス申請が必要です。

### 事前に必要なこと

- アプリの **配布方法** を選択済みであること（[Select distribution method](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method)）。  
  未設定の場合は、Protected customer data の申請画面に進めない場合があります。

### 手順

1. **Partner Dashboard を開く**  
   - [https://partners.shopify.com](https://partners.shopify.com) にログインする。  
   - 左メニューから **「Apps」** をクリックし、対象のアプリ（例: POS Receipt）を選択する。

2. **アプリの設定・データ保護の画面へ進む**  
   - アプリの管理画面で、左サイドバーまたは **「設定」** から **「データとアクセス許可」** や **「App setup」** など、データ保護・API アクセスに関する項目を開く。  
   - **「Protected customer data」** または **「保護された顧客データ」** のセクションを探す。  
     - 場所はバージョンにより **「Configuration」→「Data access」** や **「API access requests」** の近くにあることが多いです。

3. **Data protection details を入力する**  
   - **Data protection details**（データ保護の詳細）で、アプリが [protected customer data の要件](https://shopify.dev/docs/apps/launch/protected-customer-data#requirements) に沿っていることを示す内容を記入する。  
   - 必要に応じて、プライバシーポリシーやデータの保持期間などを記載する。

4. **Protected customer data で Order を選択し、理由を書く**  
   - **「Protected customer data」** を選択する。  
   - Order（注文）へのアクセスが必要である **理由** を英語で記入する。  
   - **記載例（POS Receipt 用）:**  
     ```text
     This app needs access to Order data to provide the following merchant-facing features:
     - Receipt issuance: Look up order details (order name, amount, location) to generate and print receipts from POS.
     - Settlement reports: Aggregate orders by date and location for daily settlement and inspection receipts.
     - Order search: Allow staff to search and select orders by order number or date range from the POS tile.
     We only request the minimum fields required (id, name, totalPriceSet, retailLocation, lineItems, transactions, refunds, customer display name) and do not store order data beyond what is needed for receipt and settlement records.
     ```  
   - **「Save」** をクリックする。

5. **保護されたフィールド（名前・メール等）を使う場合**  
   - 領収書で **顧客名（customer.displayName）** や **メール** を使う場合は、**Protected customer fields** で該当フィールド（Name や Email など）を選択し、同様に理由を書いて **Save** する。

6. **アクセスを申請する**  
   - **「Protected customer data access」** の近くにある **「Request access」**（アクセスを申請）ボタンをクリックする。  
   - 開発ストアのみで使うアプリは、ここまでで開発ストア向けにアクセスが有効になることがあります。  
   - ストアに公開するアプリの場合は、必要に応じて **App の審査（Submit for review）** を別途行う。

7. **申請後の確認**  
   - 申請状態や結果は、Partner Dashboard の **「API access requests」** やメールで確認できる。  
   - 承認されたら、該当ストアでアプリを **再インストール** してスコープを再度許可すると、Order にアクセスできるようになります。

### 参考リンク

- [Request access to protected customer data（公式）](https://shopify.dev/docs/apps/launch/protected-customer-data#request-access-to-protected-customer-data)  
- [Protected customer data - API types（Order が含まれる一覧）](https://shopify.dev/docs/apps/launch/protected-customer-data#protected-customer-data-api-types-and-resources)

---

## 「60日より前の注文にアクセスする必要があるのはなぜですか？」への回答例

Partner Dashboard で **「Why does your app need to access orders older than 60 days?」** と聞かれた場合に使える回答例です。そのままコピーして使うか、必要に応じて短くしてかまいません。

### 英語（フォーム用・推奨）

```
Merchants using this app need to:

1) Re-issue receipts for past orders — Customers or accounting may request a receipt long after the purchase (e.g. for tax filing, warranty, or audit). Our app stores receipt issue history; when a merchant opens a past receipt or re-issues it, we need to fetch that order to show amount, date, and location.

2) View and re-print settlement reports — The app generates daily settlement receipts for retail locations. Store managers and headquarters sometimes need to look up or re-print settlement data from previous months for accounting or reporting to the facility landlord.

We only access older orders when the merchant explicitly requests a past receipt or settlement (e.g. from receipt history or settlement history). We do not bulk-sync or store full order data beyond what is needed for these features.
```

### 日本語（意味のメモ）

- **領収書の再発行** … 顧客や経理から、購入からかなり経ったあとで領収書の発行・再発行を依頼されることがある（確定申告・保証・監査など）。発行履歴から過去の領収書を開いたり再発行するときに、その注文データを取得する必要がある。
- **精算レシートの参照・再印字** … 日次の精算レシートを出力する機能があり、店長や本部が過去月の精算を確認・再印刷したい場合がある（経理や施設オーナーへの報告のため）。そのときに該当する注文にアクセスする必要がある。
- **最小限の利用** … 過去の領収書や精算をユーザーが明示的に開いたときだけ古い注文を参照しており、一括同期や注文の全文保存はしていない、と書くとよい。

---

## 「サードパーティのセキュリティ監査または認証」の記入

**「アプリがサードパーティのセキュリティ監査または認証を受けている場合は、その種類と日付を記入してください」** という項目への答え方です。

### 受けていない場合（多くの場合）

外部のセキュリティ監査や認証（SOC 2、ISO 27001、ペネトレーションテストの第三者実施など）を **受けていない** 場合は、次のいずれかを記入します。

- **英語:** `None` または `Not applicable` または `We have not undergone a third-party security audit or certification.`
- **日本語でよい場合:** `該当なし` または `受けていない`

必須でない欄であれば、空欄のままでも問題ないことが多いです（フォームの指示に従ってください）。

### 受けている場合

次のような監査・認証を受けている場合は、**種類** と **実施日（または有効期限）** を書きます。

- **例（英語）:** `SOC 2 Type II, audit date: 2024-03` や `ISO 27001:2022, certified: 2024-01-15`
- **例（日本語）:** `SOC 2 Type II、監査日 2024年3月`

---

## 公開アプリには表示されるが自社用には表示されない理由

**公開アプリ** の Partner Dashboard には「保護された顧客データへのアクセス」（Protected customer data / Request access）が表示されるのに、**自社用アプリ** には同じ項目が表示されないことがあります。

### 理由（Shopify の仕様）

Shopify の [Protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data) では、アプリの種類ごとにアクセス可否が次のように決まっています。

| レベル | 公開アプリ (Public app) | カスタムアプリ (Custom app) | 管理者作成カスタムアプリ |
|--------|--------------------------|-----------------------------|---------------------------|
| Level 1（保護された顧客データ） | **審査が必要** (Requires review) | **常に利用可能** (Always available) | **常に利用可能** (Always available) |
| Level 2（名前・メール等のフィールド） | 審査が必要 | 常に利用可能 | プラン等により異なる |

- **公開アプリ** … 不特定のストアにインストールされるため、保護データへのアクセスには **審査と申請** が必要です。そのため Partner Dashboard に「Protected customer data」「Request access」が表示されます。
- **自社用（カスタムアプリ）** … 特定のストア向けであり、Level 1 の保護データは **「常に利用可能」** とみなされます。申請フローが不要なため、**同じ「保護された顧客データへのアクセス」申請画面は表示されません**。インストール時にスコープ（例: `read_orders`）を許可していれば、その範囲で Order 等にアクセスできます。

### 自社用で Order エラーが出る場合

自社用アプリで「Order にアクセスできません」となる場合は、次の可能性を確認してください。

1. **スコープ** … ストアでアプリをインストール／更新したときに、`read_orders` が許可されているか。
2. **再インストール** … 一度アプリをアンインストールし、再度インストールしてスコープを改めて許可する。
3. **アプリの種類** … 自社用が「カスタムアプリ」として作成されているか（配布方法が「Custom」や「Only you / 自分のストアのみ」など）。種類によっては公開アプリと同じ申請が必要な場合があります。

---

## 入力しても下書きのままになる・「App Store 提出後」の表示について

### 下書きのままになる理由

「保護された顧客データへのアクセス」を入力して **Save** しても **下書き（Draft）** のままになるのは、通常の動きです。

- **Save** は「内容を保存」するだけで、**審査に出す**ことにはなりません。
- 実際に申請するには、**「Request access」**（アクセスを申請）や **「Submit for review」** などのボタンを押す必要があります。
- 画面に **「Request access」** や **「送信」** のようなボタンがあれば、保存後にそれをクリックしてください。それでも下書きのままの場合は、**Data protection details** など必須項目が足りていないことがあるので、各セクションが完了しているか確認してください。

### 「App Store へのリスティングを提出した後、審査して…」の意味

次のような表示がある場合です。

> あなたが Shopify App Store へのリスティングを提出された後、Shopify はあなたのアクセスを審査して、次のことを確認します。  
> ・データ使用は、App Store のリストに記載されている機能と一致する  
> ・アプリは、保護された顧客データにアクセスするための Shopify の要件を満たしている  
> Shopify は、審査に関する最新情報をメールで送信します。

これは **「本番で不特定のストアに配布するとき」** の流れの説明です。

- **開発ストアだけ** で使う場合: 公式ドキュメントでは、**Request access** まで完了すれば、審査なしで開発ストアでは保護データにアクセスできるとされています（「You don't need to submit for review」）。
- **App Store に公開** して一般のストアにインストールしてもらう場合: **App Store リスティングの提出** が次のステップになり、そのタイミングで Shopify が上記 2 点を審査し、問題なければ保護データへのアクセスが本番でも有効になります。

つまり、**「保護データのスコープが使えるようになる」のは、開発ストアでは Request access 後、本番（App Store 経由）ではリスティング提出・審査後** という二段階になっているイメージです。

### 公開アプリで「customer のスコープは App Store 提出しないと使えない？」について

- **開発ストアのみ** で使う公開アプリ: Request access を送信すれば、**審査なしで開発ストアでは** 保護された顧客データ（Order など）にアクセスできる場合があります。App Store 提出は必須ではありません。
- **一般のストア**（本番）で使う場合: App Store へのリスティング提出と審査が完了しないと、そのストアでは保護データにアクセスできず、エラーになることがあります。

### 開発は自社用で進めたほうがいい？

**はい。まず自社用（カスタムアプリ）で実装・検証する進め方を推奨します。**

| 観点 | 自社用（カスタムアプリ）で開発 | 公開アプリだけで開発 |
|------|--------------------------------|----------------------|
| 保護データ（Order 等） | 申請不要で **常に利用可能** | Request access や審査の完了を待つ必要がある |
| 開発・検証の速さ | すぐに領収書・精算・注文検索を試せる | 審査結果を待つ間、本番に近い検証がしづらい |
| コード | 公開アプリと **同一コードベース** でよい（POS Receipt は toml や環境で切り替え済み） | 同じ |
| 公開アプリ化のタイミング | 自社用で安定したあと、公開アプリを提出して審査に出す | 最初から公開アプリで審査を待つ |

**おすすめの流れ**

1. **自社用アプリ** で領収書・精算・注文検索などを実装し、Order / 保護データを問題なく使える状態にする。
2. 機能が固まったら、**公開アプリ** の Partner Dashboard で保護データの申請（Request access）と、必要なら Data protection details を完成させる。
3. App Store に出す準備ができたら、**リスティングを提出** し、審査で「データ使用と機能の一致」「保護データの要件」を確認してもらう。
4. 審査通過後、公開アプリでも本番ストアで Order 等のスコープが利用可能になる。

このように **自社用で開発 → 公開アプリは後から審査・提出** にすると、待ち時間を減らしつつ、同じコードで両方に対応できます。
