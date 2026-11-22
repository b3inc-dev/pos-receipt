# 公開用の料金を出すときの 1 枚の確認表（T 向け）

公開用の POS Receipt を Shopify App Pricing で請求する変更（PR #41・#47）を本番に出すときに、上から順に見る表です。
Partner Dashboard の画面ごとの細かい手順は `docs/PARTNER_DASHBOARD_PRICING_SETUP.md`（PR #59 で足す）にあります。この表は、その要点と、本番の前後に確かめることだけを 1 枚にしたものです。

- **やる人**: T（どれも本番の操作。AGENTS.md）
- **対象**: 公開用（Partner Dashboard の「POS Receipt」・`shopify.app.public.toml`・Render `pos-receipt`）だけ
- **触らない**: 自社用（「POS Receipt - Ciara」・`shopify.app.toml`・Render `pos-receipt-ciara`）。請求なし・全機能のまま

## 1. 決まっている金額（2026-11-22 T の決定）

| プラン | 月額 | 含まれるロケーション | 超えた 1 か所 |
|---|---|---|---|
| Lite | $100 | 3 か所 | +$20/月 |
| Pro | $200 | 10 か所 | +$20/月 |

アプリの中の値: `planFeatures.server.ts` の `BILLING_PLANS`・`EXTRA_LOCATION_PRICE_USD`、`appEventsUsage.server.ts` の `INCLUDED_LOCATIONS`・`EXTRA_LOCATION_PRICE_USD`（`tests/pricing.test.mjs` で一致を確かめる）。

## 2. Partner Dashboard で作るもの

| 作るもの | 名前・handle | 金額 | 気をつけること |
|---|---|---|---|
| 料金の方式 | Managed pricing | — | 公開用アプリで選ぶ（Ciara 用ではない） |
| プラン | 名前 `Lite` | $100・毎月 | 名前に **`lite` を 1 つの言葉として**入れる |
| プラン | 名前 `Pro` | $200・毎月 | 名前に **`pro` を 1 つの言葉として**入れる |
| メーター（Lite） | `extra_location_lite` | 1 単位 $20 | handle を変えたら `APP_EVENTS_HANDLE_LITE` を入れる |
| メーター（Pro） | `extra_location_pro` | 1 単位 $20 | handle を変えたら `APP_EVENTS_HANDLE_PRO` を入れる |

**プランの名前の決まり（レビューの P2）**: アプリは契約の名前からプランを決めます（`shopPlan.server.ts` の `planFromSubscriptionName`）。

- `Pro`・`Pro Plan`・`Proプラン`・「プロ」は Pro。`Professional`・`Product` は Pro に**ならない**（前後が英字だと数えない）
- `Lite`・`Standard`・「ライト」・「スタンダード」は Lite。`Elite`・`substandard` は Lite に**ならない**（PR #63 で pro と同じ決まりにした）
- どれも入っていない名前（`Basic`・`Premium` など）は**契約なし（Lite 扱い）**になり、Pro の店が Pro の機能を使えません
- いちばん安全なのは、名前をそのまま `Lite` と `Pro` にすること

- [ ] **Partner Dashboard のプラン名（と Partner API で読むなら項目の handle）を、作ったあとに目で確かめる**
  - 読める: `Lite`・`Pro` そのもの、または `lite` / `pro` の前後が英字でない名前。区切りは空白・記号・数字・日本語のどれでもよい（例: `Lite（月額）`・`Pro Plan`・`lite_monthly`・`pro-monthly`・`Lite 2026`）
  - 読めない: `LitePlan`・`ProPlan`・`LiteMonthly`・`proplan` のように、英字がそのまま続く名前（`lite` / `pro` の後ろに英字がつながるので、1 つの言葉と見なさない）
  - 読めないとどうなるか: その店は**契約なし（Lite 扱い）**になる
    - Lite の機能はそのまま使える（Lite の店は困らない）
    - **Pro で払っている店も Lite 扱い**になり、Pro の機能（売上サマリー・入店数報告・予算管理）が使えない。DB の `planCode` も `lite` に書き直される
    - 料金プラン画面の超えたロケーションの枠に「有効な契約が無いため、超えたロケーションは数えていません」と出て、**App Events の報告は送られない**（超えた 1 か所 +$20 が請求されない）
  - 読めない名前で作ってしまったら: Partner Dashboard で名前を直す（アプリの直しは要らない）。直したあと、店がアプリを開くと門番が契約を読み直し、60 秒以内に正しいプランに戻る（推測: 名前を直したあと、すでに契約している店の契約の名前も変わるかは未確認。変わらなければ、その店にはプランを選び直してもらう）
  - 出したあとの確かめ方: 開発ストアで（`PLAN_TEST_DEV_STORE_AS_PUBLIC=1` のときだけ料金の流れを通る）Pro を選び、料金プラン画面の Pro に「ご契約中」のバッジが付く（Lite に付いたまま・「有効な契約が無いため…」と出たら、名前が読めていない）

## 3. 環境変数のスイッチ（公開用の Render だけ・どれも既定オフ）

| 変数 | 既定 | オンにすると | いつオンにするか |
|---|---|---|---|
| `APP_EVENTS_USAGE_ENABLED` | なし（オフ） | `=1` で、超えたロケーションを App Events API で 1 店・1 請求期間に 1 回報告する（請求が起きる） | メーターを作り、開発ストアで確かめたあと（T） |
| `PARTNER_API_SUBSCRIPTION_ENABLED` | なし（オフ） | `=1` で、Partner API から契約を読む（`PARTNER_API_TOKEN`・`PARTNER_API_ORG_ID`・`PARTNER_API_APP_ID` も要る） | Admin API で契約が読めないと分かったときだけ |
| `PLAN_TEST_DEV_STORE_AS_PUBLIC` | なし（オフ） | `=1` で、開発ストアも料金の流れを通す（PR #59 で足す） | 開発ストアで確かめる間だけ。終わったら消す |

- オフのままでも、超えたロケーションの数は DB の `AppUsageReport` に `disabled` で残ります（外へは送らない）。
- 報告の鍵は公開用アプリの `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` を使うので、`APP_EVENTS_CLIENT_ID` / `APP_EVENTS_CLIENT_SECRET` は入れなくてよい（入れるなら両方）。
- 報告の上限は `APP_EVENTS_USAGE_MAX_UNITS`（既定 50 か所）。
- 自社用（`APP_DISTRIBUTION=inhouse`）の Render には、どれも入れない（入れても効かないが、混ぜない）。

## 4. main に入れる直前（T の承認のあと）

- [ ] 入れる順: #47 → #41 のブランチ、そのあと #41 → main（#59 も入れるなら #41 のブランチに先に）
- [ ] **migration の時刻を付け直す**（レビューの P2）: `prisma/migrations/20261122120000_add_app_usage_report` の数字が、その時点の main のいちばん新しい migration より後かを見る。前なら、マージの直前にフォルダ名の数字を今の時刻に変える
- [ ] main とぶつからないか（GitHub の PR に「This branch has no conflicts」）・`npm test` が通るか
- [ ] Partner Dashboard の 2. が済んでいるか（済む前に入れると、公開用の「プランを選ぶ」で Shopify の料金の画面が出ない。今は開発ストアだけなので困るのは開発ストアだけ）

## 5. 本番に出したすぐあと

- [ ] Render の `pos-receipt` と `pos-receipt-ciara` の配備が Live
- [ ] **すぐに `npm run report:plan-mismatch` を取る**（レビューの P2）: Render の `pos-receipt` の Shell で打つ。前の穴で DB が Pro のままの店の一覧です。店がアプリを開くと門番が DB を契約の値に直すので、出したすぐあとでないと一覧から消えて分からなくなります。読むだけで何も書きません（`docs/PLAN_MISMATCH_REPORT.md`）。結果を連絡帳 #39 に貼り、扱いを T が決める
- [ ] 公開用の料金プラン画面に $100・$200・+$20 が出る。自社用は「自社用（無制限）」のまま
- [ ] 開発ストアで Lite → Pro に変えて、売上サマリーが開く（60 秒以内）。「未契約」のままなら `PARTNER_API_SUBSCRIPTION_ENABLED` を考える
- [ ] `APP_EVENTS_USAGE_ENABLED` をオンにしたら、Dev Dashboard の Logs でイベントが受け付けられたかを見る
- [ ] 連絡帳 #39 に、どこまで済んだかを 1 行

## 6. 戻し方

| 戻したいこと | やること |
|---|---|
| 超えたロケーションの報告を止める | `APP_EVENTS_USAGE_ENABLED` を消して再起動（送った分の請求は取り消されない） |
| Partner API で読むのをやめる | `PARTNER_API_SUBSCRIPTION_ENABLED` を消して再起動 |
| 料金の仕組みを前に戻す | #41 を戻す PR と、Partner Dashboard の料金の方式を戻す操作の両方が要る |

## まだ決まっていないこと（T）

- 無料体験の日数・年額のプランを出すか
- 未契約の店を止めるか（D15 の残り）
- ロケーションの数え方（今は有効なロケーション全部。D16 の残り）
- 前の穴で Pro のままの店の扱い（5. の一覧を見てから）
