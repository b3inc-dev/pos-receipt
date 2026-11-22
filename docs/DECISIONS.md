# DECISIONS — 設計判断・負債・未確認

コードと現行 docs から読み取れる判断・負債・未確認の一覧です。新規の仕様推測は含めません。

## 1. 確定している設計判断（コード上の意図）

| ID | 判断 | 根拠 |
|----|------|------|
| D1 | 精算の日次注文取得は GAS 同型（`location_id` + created∪updated∪cancelled）。`source_name:pos` と retailLocation 二次フィルタは付けない。注文検索ピッカーとは境界が異なる（BUSINESS_RULES §1） | `settlementEngine` `buildSettlementPreviewImpl` |
| D2 | 売上サマリー日次の基礎数値は精算プレビューと同一関数で差分ゼロ化 | `salesSummaryEngine.computeAndCacheDailySummary` → `buildSettlementPreview` |
| D3 | 実効 printMode は DB `Location.printMode`。リクエスト body は決定に使わない | `api.settlements.create.tsx` |
| D4 | `cloudprnt_direct` では Shopify 精算注文を作らない | `settlementSyncSettings` + create 分岐 |
| D5 | 精算の冪等キーは `shopId:locationId:targetDate:printMode`。点検は除外 | create ルート |
| D6 | 返金の店舗帰属は設定可能な metafield / Location フラグで制御 | `refundAggregation.server.ts` |
| D7 | ポイント利用額は割引の形で見分ける。コードの頭（初めの値 `VIP-`・`SP-POINT-`）、Shop Point 旧形式（`SP`＋16 進）、POS の手動割引の名前（初めの値 `Shop Point`）。「ポイント/会員施策設定」で変えられ、コードに固定しない。ciara-system（PR #979）と同じ初めの値。旧形式は POS Receipt だけが数える | `pointRedemptionRules.ts` + `aggregateGasStyleForOrders` |
| D8 | 公開／自社は別 toml・別 Render・APP_MODE。起動時に APP_DISTRIBUTION typo と既知 Render ホスト取り違えを拒否。deploy 後に APP_MODE を verify | `DEPLOY_PUBLIC_AND_INHOUSE.md` + `scripts/lib/deployGuard.mjs` + `server.js` |
| D9 | アプリ課金プラン（Lite/Pro）でサマリー系を制限。精算・領収書・特殊返金は全プラン。プランは Shopify の契約から読む（D15） | `planFeatures.server.ts` + `shopPlan.server.ts` |
| D10 | 特殊返金の正本は Gift Card ではなく `SpecialRefundEvent` | schema + API + GAS_vs_APP 記載 |
| D11 | （D15・D16 で置きかえ、2026-11-22）追加ロケーション $20 は App Events API の従量で報告する。既定オフのスイッチ `APP_EVENTS_USAGE_ENABLED` がオフの間は請求せず、画面にも「請求していません」と出す | `appEventsUsage.server.ts` + `app.plan.tsx` |
| D12 | プライバシーポリシー URL は AppSetting `privacyPolicyUrl` 優先、なければ env `PRIVACY_POLICY_URL`。ダミー固定 URL なし | `privacyPolicyUrl.ts` + 一般設定 / ホーム |
| D13 | `customers/data_request` は注文紐づけの ReceiptIssue / SpecialRefundEvent を列挙し PII 本文なしでログ。新規 PII 永続化なし。webhook は 200 | `webhooks.compliance.tsx` |
| D14 | LIFF 会員証は、LINE ユーザー ID の顧客メタフィールドを決めた順で読む。既定は `line_crm.line_user_id`（LINE CRM＝Shop CRM for LINE の項目。line-crm の D-APP-14）→ `socialplus.line`（SocialPlus と、LINE CRM の互換の書き込み）。環境変数 `MEMBER_CARD_LINE_ID_METAFIELDS`（`<namespace>.<key>` をカンマ区切り、多くて 4 つ）で並べ替えられる。顧客の LINE ユーザー ID は「並べた順で最初に値が入っている項目」の値（LINE CRM の項目に値があれば、古い項目の別の ID では見つけない）。タグ `line:<id>` のファストパスはそのまま（タグで見つかった人も同じ決まりで確かめる）。全件スキャンは項目ごとに `metafields.<namespace>.<key>:*` を並べた順に行う。`socialplus.line` 以外は、定義の `adminFilterable` が FILTERABLE のときだけ全件を見る（絞り込みが効かない項目で全顧客を見ない。定義が無い・オフの項目は飛ばす。先の項目を定義の読み込み・検索のエラーで見られなかったら、後の項目で探さず `API_ERROR`。Throttled は定義の読み込みも検索もやり直し、使い切ったら `THROTTLED`）。`socialplus.line` は前と同じ | `app/utils/memberCardLineFields.ts` + `app/lib/customer.server.ts` + `app/lib/memberCardFieldFilter.server.ts` |

### D15. 公開用の料金は Shopify App Pricing。プランは契約から読む（2026-11-22）

- **T の決定（2026-11-21）**: 公開用の料金は Shopify App Pricing（Billing API ではない）。POS Stock（stock-transfer-pos の main ＋ PR #82）と同じ形にする。
- **判断**:
  - アプリは契約を作らない。`app.plan.tsx` の `appSubscriptionCreate`（action）は消した。「プランを選ぶ／プランを変更」は Shopify の料金プラン画面 `https://admin.shopify.com/store/<店>/charges/<app handle>/pricing_plans` を `_top` で開くだけ。app handle は `SHOPIFY_APP_HANDLE`、無ければ `pos-receipt`（2026-11-22 T が Partner Dashboard の handle は `pos-receipt` と確認）。
  - `app.plan.callback.tsx` は planCode を書かない（URL の `?plan=` でプランを変えられた穴をふさぐ）。古いリンクのために料金プラン画面へ戻すだけ。
  - プランは `app/utils/shopPlan.server.ts` の `getShopPlan` が読む: Admin API `currentAppInstallation.activeSubscriptions`（ACTIVE で名前に Pro/プロ → Pro、Lite/Standard/ライト/スタンダード → Lite）。`PARTNER_API_SUBSCRIPTION_ENABLED=1` と `PARTNER_API_TOKEN`・`PARTNER_API_ORG_ID`・`PARTNER_API_APP_ID`（任意で `PARTNER_API_VERSION`、既定 `2026-10`）がそろったときだけ Partner API の `activeSubscription` も読む（**既定オフ**。処理は `partnerSubscription.server.ts`、POS Stock と同じ中身）。Partner で見つかればそれを正、「契約なし」なら Admin の結果、失敗なら Admin の結果だけ。
  - 読めたプランは DB `Shop.planCode` に書く（変わったときだけ）。契約なしは `lite`（今まで通り Lite の機能は使える）。読めなかったら DB の値のまま。DB の `unlimited` は上書きしない。
  - 門番は `checkShopPlanAccess(admin, shop, feature)` に一本化（今までの `getFullAccess` ＋ `checkPlanAccess(shop.planCode, …)`）。契約を読めた結果は店ごとに 60 秒覚える（ホーム・料金プラン画面などで読み直すと、その結果に置きかわる。プランを変えて戻った店を古いプランで断らない）。
  - 自社用（`APP_DISTRIBUTION=inhouse`・Ciara）は今まで通り: Shopify に聞かず全機能・請求なし。`CUSTOM_APP_STORE_IDS`・開発ストアも今まで通り全機能（POS Stock は開発ストアもプランを選ぶ形にしたが、ここでは変えていない）。ただし公開用の Render に `PLAN_TEST_DEV_STORE_AS_PUBLIC=1`（既定オフ）を入れた間は、開発ストアもふつうの店と同じく契約から決める（App Pricing の流れを開発ストアで確かめるため。手順は `docs/PARTNER_DASHBOARD_PRICING_SETUP.md`）。
- **料金（確定・2026-11-22 T の決定）**: Lite $100/月（3 ロケーションまで）・Pro $200/月（10 ロケーションまで）・超えた 1 か所 +$20/月（Lite・Pro とも）。コードの値は `planFeatures.server.ts` の `BILLING_PLANS`・`EXTRA_LOCATION_PRICE_USD` と `appEventsUsage.server.ts` の `INCLUDED_LOCATIONS`・`EXTRA_LOCATION_PRICE_USD`（`tests/pricing.test.mjs` で数と両方の一致を確かめる）。請求そのものは Partner Dashboard の App Pricing の設定（プランの月額とメーターの単価）で行うので、そちらも同じ金額にする。
- **前の穴で Pro のままの店**: 読むだけの一覧 `npm run report:plan-mismatch`（`docs/PLAN_MISMATCH_REPORT.md`、レビュー P2-5）。扱いは T が決める（未決定）。
- **未契約の店を止める（2026-11-22 T の決定: POS Stock と同じ）**: 公開用の Render に `PLAN_REQUIRE_SUBSCRIPTION=1`（**既定オフ**）を入れると、契約を読めて有効な契約が無い店は、管理画面では料金プラン画面へ移し（`app.tsx` の loader。`/app/plan` とその下は開ける）、POS の API は 402・`PLAN_REQUIRED` と決まった文を返す（`posAuth.server.ts` の `authenticatePosRequest`）。契約を読めなかった店・自社用・`CUSTOM_APP_STORE_IDS`・開発ストア・DB の `unlimited` は止めない。判定は `shouldBlockForNoSubscription`、門番と同じ 60 秒の覚えを使う（`checkSubscriptionGate`）。スイッチを既定オフにしたのは、Admin API に App Pricing の契約が出ることを開発ストアで確かめる前に入れると、払っている店まで止めるため。
- **残り**: Admin API に App Pricing の契約が出るかは未確認（出なければ Partner API のスイッチで読む）。

### D16. 超えたロケーション（+$20）は App Events API で 1 請求期間に 1 回報告する（既定オフ・2026-11-22）

- POS Stock の D15・D16（PR #80・#82）と同じ決まり。処理は `app/utils/appEventsUsage.server.ts`（POS Stock の `app-events-usage.server.ts` と同じ中身で、数と単価だけ違う）。
- 送る数は `max(0, ロケーション数 − プランに含まれる数)`（Lite 3・Pro 10）。数えるのは **POS で使うロケーションだけ**（2026-11-22 T の決定）。見分け方（2026-11-23 T がカードで確定）: 直近 30 日（`POS_LOCATION_WINDOW_DAYS`）に、このアプリで精算（`Settlement`）・領収書（`ReceiptIssue`）・特殊返金（`SpecialRefundEvent`）のどれかを使ったロケーションのうち、今 Admin API の `locations(first: 250)` に出る（有効な）もの（`countPosLocations`）。倉庫など POS で使わない所は数えない。DB を読めなければ数えず報告もしない（`count_failed`）。単価は $20 で確定（2026-11-22 T）。請求の金額は Partner Dashboard のメーターで決まるので、メーターも $20 にする。メーターの handle は既定 `extra_location_lite` / `extra_location_pro`（`APP_EVENTS_HANDLE_LITE` / `APP_EVENTS_HANDLE_PRO` で変えられる）。
- 外へ送るのは `APP_EVENTS_USAGE_ENABLED=1` のときだけ（**既定オフ**）。オフでも数は DB `AppUsageReport` に `disabled` で残す。鍵は公開用アプリ自身の client ID / client secret（client_credentials。shopify.dev の send-events のとおり）。`APP_EVENTS_CLIENT_ID` / `APP_EVENTS_CLIENT_SECRET` があればそれ、無ければ `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`。自社用（`APP_DISTRIBUTION=inhouse`）は鍵を返さない（`resolveAppEventsCredentials`）。
- 1 店・1 請求期間に 1 回: DB `AppUsageReport` の `(shop, periodEnd)` 一意 ＋ Shopify の `idempotency_key`（`posr-xloc-<店の番号>-<YYYYMMDD>`）。`periodEnd` はプランを決めた契約の今の請求期間の終わり（Partner で決めたら `currentBillingCycle.endTime`、無ければ Admin の `currentPeriodEnd`）の **UTC の日付**。Admin の期間は、ACTIVE な契約の先頭ではなく**プランを決めた契約**のものだけを使う（`selectPlanSubscription`。Partner の `legacySubscriptionId` と同じ契約 → プランの名前に合う契約 → 2 件あれば `createdAt` が新しい方。決まらず期間も違えば送らず `missing_period`）。古い Billing API の契約と App Pricing の契約が同時に ACTIVE の店（切りかえの途中）で、別の契約の期間とキーを使わないため（2026-11-22 レビュー #41 の P2-1）。同じ日付の行が無くても前後 1 日の行があれば同じ期間としてその行のキーで続ける（Partner と Admin のずれで 2 回送らない）。
- 期間の終わり 10 分前を過ぎたら送らない（次の期間の請求に入って 2 重になるため）。期間が分からないときは送らず `missing_period` で数と理由を残す。
- アプリ側の上限 `APP_EVENTS_USAGE_MAX_UNITS`（既定 50 か所）を超えたら送らず `over_limit`。失敗は `failed`（HTTP の番号・理由・回数）で残し、10 分おいて同じキー・同じ数で送り直す（最大 8 回。400・403 は自動で送り直さない）。
- 呼ぶのは `getShopPlan`（待たない）。全機能の例外（自社用・`CUSTOM_APP_STORE_IDS`・開発ストア）と DB `unlimited` の店は報告しない。
- 守りの二重化: `reportExtraLocationUsage` の中でも `APP_DISTRIBUTION=inhouse`・`CUSTOM_APP_STORE_IDS` の店なら DB も Shopify も触らずに返す（`isInhouseForUsage`。ほかから呼ばれても自社用は送らない。2026-11-22 レビュー #41 の P2-4）。
- 料金プラン画面の「超えたロケーション」の文は、数えなかった理由（`extraLocationStatus`: 範囲内・契約なし・読めない・例外）で分ける。契約が無い・読めない店に「プランの範囲内です」と出さない（P2-2）。設定・診断の画面のプラン表示も門番と同じ `checkShopPlanAccess` から読む（P2-3）。
- **残り**: 期間の途中で増えた分は取らない。shop/redact では `AppUsageReport` もその店の分を消す（2026-11-23 T の決定。POS Stock と同じ。`app/services/shopRedact.server.ts`）。アンインストール（`app/uninstalled`）では消さない（48 時間のうちに入れ直したとき、同じ期間を二重に報告しないため）。migration `20261122120000_add_app_usage_report` はマージ直前に main の最新より後の時刻へ付け直す。

### D17. 処理待ちに置いた注文の通知を 30 日で消す（2026-11-23 T の決定）

- `orders/updated` の中身（お客様の情報が入ることがある）は、売上サマリーのキュー（pg-boss・スキーマ `pgboss` の `job` と `archive`）に置かれる。このキュー（`pos-receipt-sales-summary-orders-updated`）の行で、作られてから 30 日を過ぎたものを消す（`app/services/orderWebhookQueueRetention.server.ts`）。処理中（`active`）の行は消さない。
- スイッチ `ORDER_WEBHOOK_QUEUE_PURGE`（**既定オフ**）: `preview`（数えるだけ）→ `one`（いちばん古い 1 件）→ `all`（すべて）の順に T が進める。日数は `ORDER_WEBHOOK_QUEUE_RETENTION_DAYS`（既定 30。1〜30 にそろえ、30 日より長くはできない）。
- 動くのはキューのワーカーを動かしているプロセスだけ（起動の 1 分後に 1 回、その後 24 時間ごと）。記録（ログ）には表ごとの件数だけを出し、中身は読まない。pg-boss の表や列が思った形でないときは何も消さずに `skip` と理由を出す。
- 事実（pg-boss 10.4.2 の元のコードで確かめた。`package-lock.json` の版。GitHub の `v10` の枝の `f65e9336`＝package.json が 10.4.2 のコミット。10.4.0 との違いは `src/plans.js` の型の直し 4 行だけで、日数の既定は同じ）: このアプリは `new PgBoss()` と `createQueue()` に保存の日数を渡していないので、次の既定が効く。
  - 処理されずに残った行（`created`・`retry`）: `keep_until` の既定が **14 日**（`src/plans.js` の `'14 days'`）。過ぎると `archive` へ移る。
  - 終わった行（`completed`）と失敗した行（`failed`）: **12 時間**で `archive` へ移る（`src/attorney.js` の `ARCHIVE_DEFAULT = 60 * 60 * 12`、失敗も同じ値）。
  - `archive` の行: **7 日**で消える（`deleteAfter` の既定 `'7 days'`）。
  - この片づけは `supervise`（既定オン）のとき、キューを動かしているプロセスで 2 分ごと（`maintenanceIntervalSeconds` の既定 120）に動く。
  - つまりふだんは、いちばん長くても 14 日＋7 日＝およそ 21 日で消え、30 日より前に無くなる。このスイッチは「プロセスが止まっていて片づけが動かなかったときも、30 日を超えて残らない」ことをアプリ側で守るための保険。preview の件数はふだん 0 になるはず。
- `SALES_SUMMARY_WEBHOOK_QUEUE=0` でキューを止めた店では新しく積まれないが、止める前に積まれた行は、このタイマーが動かないので残る（キューを動かして消すか、手で消す）。

### D18. customers/redact で消すもの（2026-11-23・T さん 11/23 2:35 の決定で更新）

- 指定の注文の領収書の宛名（`ReceiptIssue.recipientName`）は **空（`""`）** にする。再印字・同じキーの再発行では宛名の欄が空で出る（前は `[redacted]` の文字を入れていて、それが紙に出た）。
- その注文の特殊返金のメモ（`SpecialRefundEvent.note`。自由に書けるので、お客様の名前などが入ることがある）は **消す（null）**。金額・日時・支払方法・状態は残す（note は精算の集計に使っていないので、数字は変わらない）。
- 処理は `app/services/customerRedact.server.ts`（`redactCustomerData`）。記録（ログ）には件数だけを出す。
- `createdBy`（スタッフ）や金額・支払方法はお客様の情報ではないので残す。
- #13（`cursor/decision-audit-p2-debt-docs-0059`）にも特殊返金のメモを消す直しがあるが、topic を `"customers/redact"` と比べる古い形のままで動かず、`[redacted]` の文字を入れる。**こちら（#41 の枝）を正とする**。#13 を main 向けに入れ直す（取り込み直す）ときは、`webhooks.compliance.tsx` の customers/redact の部分は #41 の側を採り、#13 の同じ部分は捨てる（二重に作らない）。

### D19. shop/redact は「入れ直した店」なら消さない・失敗は 500（2026-11-23）

- shop/redact はアンインストールの 48 時間後に届く。そのあいだに入れ直した店のデータ（精算・領収書・設定・使用量の記録）を消さないよう、消す前に確かめる（Location Stock と同じ形。`app/services/shopInstallProbe.server.ts`）。
  - このアプリはアンインストールの webhook でセッションを消すので、オフラインのセッションが残っていれば入れ直したかもしれないと見て、Admin API（`shop { id }`）を 1 回呼ぶ。呼べたら入れ直している → 何も消さない（記録に `reinstalled` と出す）。
  - セッションが無い・401（トークンが無効）→ 入っていない → 消す。
  - それ以外（DB・通信・5xx・403）→ 分からないので消さず、500 を返す。Shopify は 2xx 以外ならもう一度送るので、消し残しにはならない。
- ルートは、HMAC の確かめ（`authenticate.webhook`）だけを try の外に置き、不正なら 401 のまま。そのあとの DB の失敗は前は 401 を返していたが、500 にした。
- 事実: `authenticate.webhook()` の `topic` は `SHOP_REDACT` の形で来る（`@shopify/shopify-api` 12.3.0 の `topicForStorage` が大文字にして `/` を `_` にする）。前のルートは `"shop/redact"` などと比べていたので、**3 つの必須 webhook のどれも中の処理が動かず 200 だけ返していた**。`normalizeWebhookTopic` でそろえて直した。これで customers/data_request（件数の記録）と customers/redact（D18）も動き始める。
- 補足（D20）: そのあと、この 2 つのルートは `authenticate.webhook()` をやめ、HMAC を自分で確かめる形にした（topic は `X-Shopify-Topic` を同じ関数でそろえる）。

### D20. アンインストールと必須 webhook は、トークンの refresh をせずに HMAC だけ自分で確かめる（2026-11-23）

- 事実: このアプリは `future.expiringOfflineAccessTokens: true`。`@shopify/shopify-app-react-router` 1.1.1 の `authenticate.webhook()` は HMAC のあと必ずオフラインのセッションを読み、期限が切れていれば refresh する。アンインストールした店では refresh が失敗し、`Response(500)` を投げる（ルートの try より前）。そのため、
  - app/uninstalled: 最後の refresh から約 1 時間より後にアンインストールした店では 500 になり、セッションが消えなかった。
  - shop/redact（48 時間後）: 残ったセッションの refresh が失敗して毎回 500 になり、何も消えなかった。
- Shopify は 4.0.3（`ecbcb1b`）で直した。ただし 1.1.1 → 4.x は大きな版の上げ（2.0.0 で Node 22 必須・`isEmbeddedApp` の廃止など、3.0.0 で events の型、4.0.0 で Polaris 2 が既定になり画面の見た目が変わる、セッションの保存の部品も 7 系へ）なので、今回は上げない。
- 直し: `webhooks.app.uninstalled.tsx` と `webhooks.compliance.tsx` は `authenticate.webhook()` を使わず、`app/services/webhookHmac.server.ts`（`verifyShopifyWebhookRequest`）で HMAC を自分で確かめる（`X-Shopify-Hmac-Sha256`・`SHOPIFY_API_SECRET`・`timingSafeEqual`）。セッションは読まない・refresh しない。
  - POST 以外は 405、HMAC・topic・店のヘッダーが無い／本文が JSON でないは 400、HMAC が合わない（秘密が空のときも）は 401。ライブラリと同じ答え方。
  - app/uninstalled はセッションを必ず消す（`deleteMany`。何度来ても同じ）。DB の失敗は 500（Shopify がもう一度送る）。
- これで D19 の前提「アンインストールの webhook でセッションを消すので、shop/redact のときにセッションが残っていれば入れ直した」が成り立つ。
- 残ること（推測）: shop/redact で入れ直したかを確かめる `unauthenticated.admin()` も同じ refresh を通る。入れ直した店ならトークンは有効なので通る。app/uninstalled が 48 時間ずっと失敗して古いセッションが残った店だけは、refresh の失敗（500）になり消せない（記録に `Response 500 (token refresh or Admin API failed)` と出る）。めったに起きないので、出たら手で確かめる。
- `webhooks.orders.updated.tsx` は今までどおり `authenticate.webhook()`（Admin API が要るため。アンインストールした店には来ない）。
- あとで shopify-app-react-router を 4.0.3 以上に上げたら、この 2 つのルートを `authenticate.webhook()` に戻してもよい（そのときは Polaris の版の固定を忘れない）。

## 2. 古い docs との差分（注意）

| ドキュメント | 記載 | 現行コード |
|--------------|------|------------|
| `LOCATION_AND_SOURCE_VERIFICATION.md` | 精算クエリに `source_name:pos`、retailLocation 二次フィルタ | 精算メインパスでは **どちらも無し**。注文検索には残存 |
| 同・売上サマリー節 | 独自 `shopifyQuery` + filter | 現状は `buildSettlementPreview` 再利用。`fetchSummaryOrders` 等はファイル内に残るが呼び出し無し |
| `GAS_vs_APP_IMPLEMENTATION_GAP.md` 一部「未対応」節 | タイムゾーンや特殊返金未反映など | 冒頭では対応済と更新済みだが、本文の「現在の実装」段落が古いまま残っている箇所あり。**挙動はコードを正** |
| `PROGRESS_SUMMARY.md` | 最終更新 2026-03-12 | その後の返金帰属・Shopify 返金実行等が追加されている |

## 3. 技術的負債・重複・混在

| 項目 | 内容 |
|------|------|
| 決済名称の二重系（軽減） | 集計バケットキーは依然 `gasNormalizeGatewayLabel`。表示は `resolvePaymentSectionLabel` で raw/formatted/displayLabel を単一マッチ（日本語キー含む）。集計キー自体のハードコードは残存 |
| ロケーション ID 正規化の重複 | `extractLocationNumericId` / `normalizeLocationGid` が複数ファイルに存在（返金照合は `refundAggregationPure` の数値 ID 比較に寄せた） |
| 返金オーバーレイ死コード | `getRefundOverlayForDay` / `computeRefundsOnlyForDay` は定義・export されるが、プレビュー本体からの適用は無く、他ファイルからの import も見当たらない |
| 売上サマリー死コード | `SUMMARY_ORDERS_QUERY` / `fetchSummaryOrders` / `filterSummaryOrdersByRetailLocation` が未使用のまま残存 |
| 表示と集計の混在（軽減） | payment section の `gateway` は集計キーのまま。`label` はマスタ解決。マスタ未登録の日本語キーはキー＝表示のまま |
| 精算設定ラベル未使用 | UI で項目名を変えられても `buildSettlementReceiptText` は固定文言 |
| 点検 UI と実装 | DoneView は点検で Shopify 注文を作らない旨を示しうるが、`order_based` では `syncInspectionOrderLikeGas` を呼びうる |
| customAttributes | 取得するが UI 非表示 |
| レガシー Gift Card | 設定デフォルト／検証用フラグ。API 失敗は握りつぶして続行 |
| API バージョン分散 | Admin SDK / Webhook TOML / POS extension で宣言が異なる |
| Fulfillment / Draft complete | V2→旧 API、paymentPending→単純 complete のフォールバック（互換のための分岐） |

## 4. 安全性（金額・返金・件数）

| リスク | 現行の扱い |
|--------|------------|
| created∪updated の二重計上 | 注文 id で union |
| オーバーレイと本集計の二重 | オーバーレイ未適用のため現状は二重にならない（死コード） |
| Gift Card と注文の二重 | POS union に含まれる orderId はレガシー加算スキップ |
| 精算の再実行 | 冪等キーで Settlement 行の重複作成を防止。再同期で Shopify 側は更新しうる |
| 点検の再実行 | 冪等なし → 複数回作成しうる |
| 返金ロケーション不一致 | その精算から除外 → **他店計上漏れ／過少**のリスク（設定依存） |
| GraphQL エラー | リトライ／スロットルあり。同期失敗時 create は 500。キャッシュ失敗は精算成功を落とさない箇所あり |
| 過去データ | 履歴は Settlement スナップショット。再計算 API はプレビュー中心 |
| 領収書 | idempotencyKey。POS は createdBy 未送信 |

## 5. Printing API 移行に関する判断（実装しない）

- **現状維持対象として分離**: 集計・特殊返金・DB・metafield
- **置換候補として分離**: order_based の「印字のためだけに作る SETTLEMENT 注文」、cloudprnt の配送手段、領収書の非印字
- 本リポジトリ調査時点で Printing API 実装は行わない（`SHOPIFY.md` §7）

## 6. 未確認事項リスト（横断）

1. Shopify Printing API / POS プリンタでの精算レイアウト印字の実現可否と前提条件
2. CloudPRNT 実機の認証・紙幅・文字コードと payload の適合（設定項目はあるが実行アダプタなし）
3. Shopify POS Pro / Light プラン差分が本アプリ動作に与える影響（コード参照なし）
4. 配送注文・送料を精算に含める／除外する業務ルールの正式決定（コード上は送料非集計）
5. POS キャンセルと Admin キャンセルを件数上どう区別すべきか（コード上区別なし）
6. `ReceiptIssue.createdBy` を運用で埋めるか
7. line item properties を精算／領収書に出す要件の有無
8. ギフトレシート（Shopify Gift Receipt）要件の有無（現行未実装）
9. GitHub 上の CI / 必須チェックの有無（リポジトリ内 workflow なし）
10. Admin API October25 と webhook 2026-04 の併用方針
11. `legacyGiftCardAggregationEnabled` の本番推奨値
12. 死コード（refund overlay / summary fetch）削除の是非
13. 点検 DoneView 文言と order_based 同期のどちらを仕様とするか
14. 精算設定の表示項目名を印字テキストへ反映する要件の有無

## 7. 変更時の推奨確認観点（ドキュメント作業以外）

金額・件数に触れる実装変更時は少なくとも次を確認する:

- `aggregateGasStyleForOrders` の orderCount / itemCount / refundCount 定義
- 返金帰属ゲートとの整合
- 特殊返金イベント反映フラグ
- 売上サマリーが同一プレビューを読むこと
- 冪等キーとロック
- order_based / cloudprnt_direct の分岐

## 8. 開発ストアだけに出すもの（2026-11-22）

- **一般設定のデバッグ・診断の欄とシステム診断は開発ストアだけ**（T さんの決定 2026-11-22）: 一般設定の「デバッグモード」「診断パネルを有効にする」「詳細計算ログ」「プラン（表示用）」「有効機能 JSON（表示用）」、店舗設定とホームの「システム診断」の枠、高度な設定の「システム診断」ボタン、`/app/diagnostics` の画面は、Shopify の `shop.plan.partnerDevelopment` が true の店だけに出す。店の名前はコードに書かない。読めない・失敗したときは出さない（`/app/diagnostics` は 404。店と DB を読む前に止める）。開発ストアでない店から保存が来ても、一般設定のこの 5 つは保存済みの値のまま（`app/utils/devStore.server.ts`）。自社用（inhouse）や `CUSTOM_APP_STORE_IDS` は本番の Ciara も入るので、この判定には使わない。
