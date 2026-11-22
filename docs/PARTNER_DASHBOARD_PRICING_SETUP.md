# 公開用の料金を Partner Dashboard で設定する手順（T 向け）

公開用の POS Receipt を Shopify App Pricing（Managed pricing）で請求するための手順です。アプリ側の動き（契約を読む・契約を作らない・超えたロケーションを App Events API で報告する）は PR #41・#47 と `docs/DECISIONS.md` の D15・D16 にあります。

- **やる人**: T。Partner Dashboard の設定・Render の環境変数・main へのマージは、どれも本番の操作です（AGENTS.md）。
- **対象**: 公開用アプリ（app handle `pos-receipt`・`shopify.app.public.toml`・Render `pos-receipt`）。
- **触らないもの**: 自社用（POS Receipt - Ciara・`shopify.app.toml`・Render `pos-receipt-ciara`）。自社用は請求なし・全機能のままです。
- Partner Dashboard の画面の名前と場所は、Shopify の変更で違うことがあります（この手順を書いた 2026-11-22 時点で画面そのものは見ていません。名前が違うときは同じ意味の項目を探してください）。

## 決まっている値（2026-11-22 T の決定）

| 項目 | 値 | アプリの中の場所 |
|---|---|---|
| Lite | $100/月・3 ロケーションまで | `planFeatures.server.ts` の `BILLING_PLANS.lite` |
| Pro | $200/月・10 ロケーションまで | `BILLING_PLANS.pro` |
| 超えた 1 か所 | +$20/月（Lite・Pro とも） | `EXTRA_LOCATION_PRICE_USD`（`planFeatures`・`appEventsUsage` の 2 か所。`tests/pricing.test.mjs` で一致を確かめる） |
| 無料体験 | 14 日（Lite・Pro とも） | アプリでは持たない（Shopify の契約の設定） |
| 請求の間隔 | 月額だけ（年額は出さない。2026-11-22 T の決定。メーターは月額のプランにだけ付くため） | — |
| app handle | `pos-receipt`（T 確認済み） | `getPublicAppHandle`（`SHOPIFY_APP_HANDLE` は入れなくてよい） |
| メーターの handle | `extra_location_lite` / `extra_location_pro` | `APP_EVENTS_HANDLE_LITE` / `APP_EVENTS_HANDLE_PRO`（既定のままでよい） |

## そのほかの決定（2026-11-22 T）

- 未契約の店は止める（POS Stock と同じ）。スイッチ `PLAN_REQUIRE_SUBSCRIPTION=1` で始める（手順 8。既定オフ）
- 超えたロケーションは POS で使う所だけ数える。直近 30 日にこのアプリで精算・領収書・特殊返金を使った、有効なロケーション（倉庫などは数えない）

## 順番の全体

1. Partner Dashboard で Managed pricing にする
2. プラン（Lite・Pro）を作る
3. メーター（超えたロケーション）を付ける
4. #41（＋#47 と、この手順書の PR）を main に入れる（T の承認）
5. 開発ストアで確かめる（スイッチは開発ストアの確かめ用だけ）
6. （任意）Partner API で契約を読む
7. 超えたロケーションの報告をオンにする
8. 未契約の店を止める

**1〜3 と 4 の間はなるべく空けない**でください。Managed pricing にすると Billing API（`appSubscriptionCreate`）で契約を作れなくなります（Shopify の決まり。shopify.dev の Managed pricing の説明）。今の main の料金プラン画面は Billing API で契約を作るので、4 を入れるまで公開用の「プランを選ぶ」は失敗します。逆に 4 を先に入れると、1 が済むまで「プランを選ぶ」で開く Shopify の料金プラン画面が出ません。今、公開用を入れているのは開発ストアだけ（T・2026-11-22）なので、どちらの順でも困るのは開発ストアだけです。

## 1. Managed pricing にする

1. Partner Dashboard → アプリ → **POS Receipt（公開用）** を開く。自社用の「POS Receipt - Ciara」ではないことを確かめる。
2. 配信（Distribution）→ ストアの掲載を管理（Manage listing）→ 料金（Pricing）の設定を開く。
3. 料金の方式で **Managed pricing**（Shopify が料金プラン画面を出す方式）を選ぶ。

## 2. プランを作る

アプリは、契約の名前（Partner API で読むときは handle）に次の言葉が入っているかでプランを決めます（`shopPlan.server.ts` の `planFromSubscriptionName`）。

- Pro: `pro`（前後が英字でないとき。`Pro`・`Pro Plan`・`Proプラン` は Pro。`Professional`・`Product` は Pro にならない）または「プロ」
- Lite: `lite`・`standard`・「ライト」・「スタンダード」
- どれも入っていない名前（`Basic`・`Premium` など）は Lite 扱いになります。**名前は `Lite` と `Pro` にしてください。**

| 項目 | Lite | Pro |
|---|---|---|
| 名前 | `Lite` | `Pro` |
| 請求 | 毎月（Monthly） | 毎月（Monthly） |
| 金額 | $100 | $200 |
| 無料体験 | 14 日（2026-11-22 T の決定） | 14 日 |
| 説明（例） | 3 ロケーションまで。精算・点検レシート、特殊返金・商品券調整、領収書、販売レシート | 10 ロケーションまで。Lite の機能に加えて、売上サマリー・入店数報告・予算管理 |

## 3. メーター（超えたロケーション）を付ける

| プラン | メーターの handle | 種類 | 1 単位の金額 | 説明（例） |
|---|---|---|---|---|
| Lite | `extra_location_lite` | Fixed | $20 | プランに含まれる 3 か所を超えたロケーション 1 か所につき |
| Pro | `extra_location_pro` | Fixed | $20 | プランに含まれる 10 か所を超えたロケーション 1 か所につき |

- handle は上のとおりに入れる（違う handle にしたときは、公開用の Render に `APP_EVENTS_HANDLE_LITE` / `APP_EVENTS_HANDLE_PRO` を入れる）。
- App Pricing のメーターには上限が付けられないので、アプリ側の上限 `APP_EVENTS_USAGE_MAX_UNITS`（既定 50 か所）で止めます。
- メーターを付けても、アプリが報告するまでは請求されません（報告は手順 7 でオンにするまでオフ）。

## 4. main に入れる（T の承認）

- 入れるもの: #41（料金の本体）。#47（確定の金額）と、この手順書の PR は #41 のブランチに先に入れる。
- #41 には migration（`AppUsageReport` の表を足す）が入っています。マージすると本番の DB に表が増えます（スイッチはオフのまま）。migration の時刻（`20261122120000`）は main の最新より後になっていることを、マージの直前にもう一度確かめる。
- マージのあと、Render の公開用・自社用の配備が Live になったことを確かめる。自社用の料金プラン画面は「自社用（無制限）」のままです。

## 5. 開発ストアで確かめる

アプリは開発ストアを全機能の例外にしています（プランを選ばなくても全部使える）。そのままでは料金の流れを確かめられないので、確かめる間だけ次のスイッチを使います。

1. 公開用の Render（`pos-receipt`）に `PLAN_TEST_DEV_STORE_AS_PUBLIC=1` を入れて再起動する。**自社用の Render には入れない**（自社用では効きませんが、混ぜないため）。開発ストアでない店には効きません。
2. 開発ストアでアプリの「料金プラン」を開く。バッジが「未契約」、ボタンが「プランを選ぶ」になる。
3. 「プランを選ぶ」→ Shopify の料金プラン画面で Lite を選んで承認する（開発ストアの請求はテスト扱いで、お金はかかりません）。
4. アプリに戻ると、バッジが「Liteプラン」、Lite のカードに「ご契約中」。売上サマリーを開くと Pro が要ると断られる。
5. 「プランを変更」→ Pro に変える → アプリに戻ると「Proプラン」。売上サマリーが開く（遅くても 60 秒以内）。
6. 戻っても「未契約」のままのときは、Admin API に App Pricing の契約が出ていません（D15 の未確認）。手順 6 の Partner API をオンにして、もう一度開く。
7. 終わったら `PLAN_TEST_DEV_STORE_AS_PUBLIC` を消して再起動する（開発ストアは全機能に戻る）。手順 7 の報告を開発ストアで試すときは、消すのはそのあと。

## 6. （任意）Partner API で契約を読む

Admin API で契約が読めていれば要りません（手順 5 の 6 で「未契約」のままだったときに使う）。

1. Partner Dashboard → 設定 → Partner API クライアント → 新しく作る。権限は **Manage apps だけ**。
2. 公開用の Render に入れる:
   - `PARTNER_API_TOKEN`: 作ったトークン（秘密。チャットやログに貼らない）
   - `PARTNER_API_ORG_ID`: Partner Dashboard の URL `partners.shopify.com/<この数字>/…`
   - `PARTNER_API_APP_ID`: 公開用アプリを開いたときの URL `…/apps/<この数字>`
   - `PARTNER_API_SUBSCRIPTION_ENABLED=1`
   - （`PARTNER_API_VERSION` は既定 `2026-10` のままでよい）
3. 再起動して手順 5 の 2〜5 をもう一度。

## 7. 超えたロケーションの報告をオンにする

1. 鍵は**新しく入れなくてよい**。報告には公開用アプリ自身の client ID / client secret を使い、これは公開用の Render に入っている `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` と同じ値（#44。無いときはそれを使う）。公開用の Render に `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` が入っていることだけ確かめる。`APP_EVENTS_CLIENT_ID` / `APP_EVENTS_CLIENT_SECRET` は入れない（入れるなら両方。片方だけだと送らずに理由を残す）。自社用（Ciara）の Render には何も入れない（自社用は鍵があっても送らない）。
2. まず開発ストアで: `PLAN_TEST_DEV_STORE_AS_PUBLIC=1` のまま Lite を選び、4 か所以上のロケーションで POS から精算・領収書・特殊返金のどれかを 1 回ずつ使う（数えるのは直近 30 日に使った、有効なロケーションだけ）。
3. `APP_EVENTS_USAGE_ENABLED=1` を入れて再起動し、料金プラン画面を開く。「POS で使うロケーション 5 か所のうち、3 か所を超えた 2 か所 × $20 ＝ $40」と、報告の状態が出る。
4. Dev Dashboard の Logs で、そのイベントが受け付けられたことを確かめる（Shopify の 202 は「受け取った」だけなので、請求に載ったかは Logs で見る）。
5. 問題なければ `PLAN_TEST_DEV_STORE_AS_PUBLIC` を消す。`APP_EVENTS_USAGE_ENABLED=1` はそのまま（ほかの店でも報告が始まる）。

報告は 1 店・1 請求期間に 1 回です。期間の終わり 10 分前を過ぎると送りません。送れなかった分は DB の `AppUsageReport` に理由（`failed`・`over_limit`・`missing_period`）が残ります。

## 8. 未契約の店を止める

手順 5 で、プランを選んだあと料金プラン画面に「Liteプラン」「Proプラン」と出た（Admin API か Partner API で契約を読めた）ことを確かめてから入れます。読めないまま入れると、払っている店まで止めてしまいます。

1. 開発ストアで: `PLAN_TEST_DEV_STORE_AS_PUBLIC=1` のまま、公開用の Render に `PLAN_REQUIRE_SUBSCRIPTION=1` を入れて再起動する。
2. 開発ストアの契約を Shopify の料金プラン画面で解約する。アプリを開くと、どの画面からも料金プラン画面に移る。POS のタイルを開くと「プランが選ばれていません。…「料金プラン」でプランを選んでください。」と出る。
3. もう一度 Lite を選ぶ → アプリと POS が元どおり使える（遅くても 60 秒以内）。
4. `PLAN_TEST_DEV_STORE_AS_PUBLIC` を消す（開発ストアは全機能に戻り、止められない）。`PLAN_REQUIRE_SUBSCRIPTION=1` はそのまま。

契約を Shopify から読めなかったとき（混雑など）は止めません。自社用（Ciara）には効きません。

## 戻し方

| 戻したいこと | やること |
|---|---|
| 超えたロケーションの報告を止める | `APP_EVENTS_USAGE_ENABLED` を消して再起動（送った分の請求は取り消されない） |
| Partner API で読むのをやめる | `PARTNER_API_SUBSCRIPTION_ENABLED` を消して再起動 |
| 未契約の店を止めるのをやめる | `PLAN_REQUIRE_SUBSCRIPTION` を消して再起動 |
| 開発ストアを全機能に戻す | `PLAN_TEST_DEV_STORE_AS_PUBLIC` を消して再起動 |
| 料金の仕組みを前の形（Billing API）に戻す | #41 を戻す PR と、Partner Dashboard の料金の方式を戻す操作の両方が要る。Managed pricing で契約した店がいるとややこしいので、開発ストアだけのうちに決める |

## 終わったら確かめる

- [ ] Partner Dashboard のプランが `Lite` $100・`Pro` $200（毎月）
- [ ] メーターが `extra_location_lite` / `extra_location_pro`、1 単位 $20
- [ ] App Store の掲載の料金の文が同じ金額
- [ ] 公開用の料金プラン画面に $100・$200・$20 が出る。自社用は「自社用（無制限）」
- [ ] `PLAN_TEST_DEV_STORE_AS_PUBLIC` を消した
- [ ] 連絡帳（#39）に、どこまで済んだかを 1 行
