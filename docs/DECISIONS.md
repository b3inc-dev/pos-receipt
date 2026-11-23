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
| D6 | 返金の店舗帰属は設定可能な metafield / Location フラグで制御。注文基準モードの精算は metafield を計上先に使わない（不一致ログのみ）。返金基準モードだけ当日返金 TX → metafield → resolve | `refundAggregation.server.ts` / `decideRefundAttributionForSettlement` |
| D7 | ポイント利用額は割引の形で見分ける。コードの頭（初めの値 `VIP-`・`SP-POINT-`）、Shop Point 旧形式（`SP`＋16 進）、POS の手動割引の名前（初めの値 `Shop Point`）。「ポイント/会員施策設定」で変えられ、コードに固定しない。ciara-system（PR #979）と同じ初めの値。旧形式は POS Receipt だけが数える | `pointRedemptionRules.ts` + `aggregateGasStyleForOrders` |
| D8 | 公開／自社は別 toml・別 Render・APP_MODE。起動時に APP_DISTRIBUTION typo と既知 Render ホスト取り違えを拒否。deploy 後に APP_MODE を verify | `DEPLOY_PUBLIC_AND_INHOUSE.md` + `scripts/lib/deployGuard.mjs` + `server.js` |
| D9 | アプリ課金プラン（Lite/Pro）でサマリー系を制限。精算・領収書・特殊返金は全プラン | `planFeatures.server.ts` |
| D10 | 特殊返金の正本は Gift Card ではなく `SpecialRefundEvent` | schema + API + GAS_vs_APP 記載 |
| D11 | 追加ロケーション $20 従量は未実装。Billing は Lite/Pro 定額のみ。UI で課金済み表示にしない（`EXTRA_LOCATION_USAGE_BILLING_ENABLED=false`） | `app.plan.tsx` + `planFeatures.server.ts` |
| D12 | プライバシーポリシー URL は AppSetting `privacyPolicyUrl` 優先、なければ env `PRIVACY_POLICY_URL`。ダミー固定 URL なし | `privacyPolicyUrl.ts` + 一般設定 / ホーム |
| D13 | `customers/data_request` は注文紐づけの ReceiptIssue / SpecialRefundEvent を列挙し PII 本文なしでログ。`customers/redact` は recipientName と SpecialRefundEvent.note を対称 redact。新規 PII 永続化なし。webhook は 200 | `webhooks.compliance.tsx` |
| D14 | LIFF 会員証は、LINE ユーザー ID の顧客メタフィールドを決めた順で読む。既定は `line_crm.line_user_id`（LINE CRM＝Shop CRM for LINE の項目。line-crm の D-APP-14）→ `socialplus.line`（SocialPlus と、LINE CRM の互換の書き込み）。環境変数 `MEMBER_CARD_LINE_ID_METAFIELDS`（`<namespace>.<key>` をカンマ区切り、多くて 4 つ）で並べ替えられる。顧客の LINE ユーザー ID は「並べた順で最初に値が入っている項目」の値（LINE CRM の項目に値があれば、古い項目の別の ID では見つけない）。タグ `line:<id>` のファストパスはそのまま（タグで見つかった人も同じ決まりで確かめる）。全件スキャンは項目ごとに `metafields.<namespace>.<key>:*` を並べた順に行う。`socialplus.line` 以外は、定義の `adminFilterable` が FILTERABLE のときだけ全件を見る（絞り込みが効かない項目で全顧客を見ない。定義が無い・オフの項目は飛ばす。先の項目を定義の読み込み・検索のエラーで見られなかったら、後の項目で探さず `API_ERROR`。Throttled は定義の読み込みも検索もやり直し、使い切ったら `THROTTLED`）。`socialplus.line` は前と同じ | `app/utils/memberCardLineFields.ts` + `app/lib/customer.server.ts` + `app/lib/memberCardFieldFilter.server.ts` |
| D15 | 精算・印字の税／純売上の正は設定税率％による税込逆算。`taxShopify`（注文税×keepRatio）は診断用 | `settlementTaxPure` + preview DTO |
| D16 | レガシー Gift Card API 集計の既定は OFF（検証時のみ ON）。T が OFF に決めた（2026-11-22 時点の連絡帳 #39）。既定の変更（ON→OFF）は #13 で入る。本番の店は #16 を出す前に設定画面でチェックを外して保存する | `DEFAULT_SETTLEMENT_SETTINGS` |
| D17 | Printing API は Conditional-Go で並存。旧 order_based / cloudprnt は残置。紙幅は中立 `paperWidthMm`（`cloudprntPaperWidth` と同期） | `printApi.js` + `printPaperWidth.ts` + P0 SETTLEMENT 抑制方針 |
| D18 | 特殊返金の Shopify 返金が `pending`（成否不明）のあいだは精算を確定しない。二重計上も抜けも出さないため | `assertNoPendingSpecialRefunds`（`specialRefundOverlayPure.server.ts`） |
| D19 | 精算注文（SETTLEMENT）を作るかは、印字設定「精算注文を作成」（`createSettlementOrderWhenPrinting`）の保存が無ければ ON。管理画面は保存が無いとチェックが入って見えるので、サーバーも同じにそろえる（今の本番の動きを続ける）。作らないのは、チェックを外して保存したとき・精算設定 `orderBasedCreateSettlementOrderEnabled=false`・`cloudprnt_direct`。作らなかったとき API は `settlementOrderSkipped: true` を返し、POS は「再インストール」を案内しない | `settlementSyncSettings.server.ts` `shouldCreateSettlementOrder` |
| D20 | 前からある pending の特殊返金（ID が `pos_sr_` で始まらない）は、Shopify を読み直して決めるだけで返金を実行しない | `specialRefundLegacyRecheck.server.ts` / `api.special-refunds.$id.recheck.tsx` |
| D21 | 確定値を守る（T の決定 2026-11-22・Issue #20）。確定済みの日は、もう一度「確定」を押しても DB の Settlement の値を返し、Shopify の精算注文は書き換えない。再集計は比べるために集計し、数が変わっていれば `changedSinceConfirm` を返す。**再確定**（create の `reconfirm: true`、T の決定 2026-11-23 4:20）は今の数で確定し直し、前の行は `status=superseded`・冪等キーなしで履歴に残す（migration なし）。order_based は精算注文も新しい値に直す。点検は毎回その時点の金額を保存し、返金処理中（pending）の特殊返金があっても警告つきで出す（T の決定 2026-11-23 4:25。pending の分は数に入れず、売上サマリーのキャッシュも書かない）。精算の確定・再確定・再集計は pending で止める（D18） | `api.settlements.create.tsx` / `api.settlements.recalculate.tsx` / `api.settlements.preview.tsx` / `settlementConfirmedPure.server.ts` |
| D22 | 売上に含めない送料等（明細の `_lsi_fee="1"` かつ `_lsi_fee_sales="0"`。Location Stock #76）は、支払方法別の金額に残したまま総売上・純売上・税・点数・割引から外し、`nonSalesFeeTotal` として分けて出す。領収書の金額は受け取った全額のまま（T 2026-11-23）。見分けは明細の属性だけ（名前は見ない）。店ごとの切り替えは Location Stock の管理画面の設定が明細に残す値で決まり、POS Receipt 側に設定は足さない。Settlement に列は足さず、保存済みの印字は「支払方法別の合計 − 総売上」で戻す（BUSINESS_RULES §7.1） | `nonSalesFeeLines.ts` + `aggregateGasStyleForOrders` + `buildSettlementPreviewImpl` |
| D23 | 返金処理中（`pending`）のまま最後に試してから 5 分（`SPECIAL_REFUND_AUTO_RESOLVE_AFTER_MINUTES`・2〜1440）たった特殊返金は、アプリが自動で Shopify の注文の返金を **読むだけ** で決める（T 2026-11-23 4:25）。`pos_sr_` の登録は返金ノートの印 `[POS_RECEIPT_EVENT:<ID>]` があれば `success`、無ければ `failed`（返金は作られていない）。前からの登録は印か「特殊返金」のノート・種別・金額が合う 1 件だけなら `success`、それ以外は店の人が選ぶまで `pending`。refundCreate は呼ばないので返金は 2 回にならない。DB は active・pending・`updatedAt` が読んだときと同じ行だけ書き換える（POS の送り直しと重ならない）。呼ぶのは精算の集計の最初（その日・その店）、POS の特殊返金の一覧（その注文）、pg-boss の 5 分ごとの見回り（`pos_sr_` だけ・全店）。自動の確定は既定でオフで、`SPECIAL_REFUND_AUTO_RESOLVE=1` のときだけ動く。自動で `failed` にした登録は POS の同じキーの送り直しで `pending` に戻し、同じ冪等キーで返金し直す（T 2026-11-23）。番号はほかの積み上げ PR（D20・D21）と重なったら付け直す | `specialRefundAutoResolvePure.server.ts` / `specialRefundAutoResolveCore.server.ts` / `specialRefundAutoResolve.server.ts` / `specialRefundAutoResolveQueue.server.ts` |

## 2. 古い docs との差分（注意）

| ドキュメント | 記載 | 現行コード |
|--------------|------|------------|
| `LOCATION_AND_SOURCE_VERIFICATION.md` | 精算クエリに `source_name:pos`、retailLocation 二次フィルタ | 精算メインパスでは **どちらも無し**。注文検索には残存 |
| 同・売上サマリー節 | 独自 `shopifyQuery` + filter | 現状は `buildSettlementPreview` 再利用。旧 `fetchSummaryOrders` 等は削除済み |
| `GAS_vs_APP_IMPLEMENTATION_GAP.md` 一部「未対応」節 | タイムゾーンや特殊返金未反映など | 冒頭では対応済と更新済みだが、本文の「現在の実装」段落が古いまま残っている箇所あり。**挙動はコードを正** |
| `PROGRESS_SUMMARY.md` | 最終更新 2026-03-12 | その後の返金帰属・Shopify 返金実行等が追加されている |

## 3. 技術的負債・重複・混在

| 項目 | 内容 |
|------|------|
| 決済名称の二重系（軽減） | 集計バケットキーは依然 `gasNormalizeGatewayLabel`。表示は `resolvePaymentSectionLabel` で raw/formatted/displayLabel を単一マッチ（日本語キー含む）。集計キー自体のハードコードは残存 |
| ロケーション ID 正規化の重複（軽減） | 同じ関数の写し 6 か所を `app/utils/locationGid.ts` にまとめた（`refundAggregationPure` は再公開）。各ルート・集計の `replace("gid://shopify/Location/", "")` などのその場の書き方はまだ残る（触る PR が多いので、そのファイルを直すときに寄せる） |
| 返金オーバーレイ死コード | `getRefundOverlayForDay` / `computeRefundsOnlyForDay` は定義・export されるが、プレビュー本体からの適用は無く、他ファイルからの import も見当たらない |
| 表示と集計の混在（軽減） | payment section の `gateway` は集計キーのまま。`label` はマスタ解決。マスタ未登録の日本語キーはキー＝表示のまま |
| 精算設定ラベル未使用 | UI で項目名を変えられても `buildSettlementReceiptText` は固定文言 |
| 点検 UI と実装 | DoneView は点検で Shopify 注文を作らない旨を示しうるが、`order_based` では `syncInspectionOrderLikeGas` を呼びうる |
| customAttributes | 取得するが UI 非表示 |
| レガシー Gift Card | 既定 OFF（T が 2026-11-22 までに OFF に決定）。ON 時のみ API 加算。取得失敗時は精算を確定しない（以前は握りつぶして 0 円のまま続行していた） |
| 用紙幅キー | 中立 `paperWidthMm` を追加済み。レガシー `cloudprntPaperWidth` は同期エイリアスとして残置（フルリネームは未実施） |
| API バージョン（解消） | Admin SDK と Webhook TOML は `2026-04` にそろえ、テストで見張る。POS extension `2026-07` は別系列（docs/SHOPIFY.md §2） |
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

## 5. Printing API（Conditional-Go・c69438d 以降）

- **実装済み**: `shopify.printing` ラッパ、精算／領収書／販売の HTML ルート、Admin の prefer フラグ、拡張 `api_version` 2026-07
- **残置**: `order_based` / `cloudprnt_direct`（Location.printMode）。CloudPRNT は Advanced／廃止候補
- **P0 方針**: Printing 主経路では印字用途の SETTLEMENT 作成をスキップ（監査アーカイブはオプトイン）
- **旧経路完全削除**: mPOP 実機 Go 後の別承認
- **触らない核**: 集計・特殊返金 DB・metafield・返金帰属

## 6. 未確認事項リスト（横断）

1. mPOP＋POS 11.11+ 実機での Printing 直印字品質（旧経路削除の前提）
2. CloudPRNT 実機の認証・文字コードと payload の適合（設定項目はあるが実行アダプタなし）
3. Shopify POS Pro / Light プラン差分が本アプリ動作に与える影響（コード参照なし）
4. 配送注文・送料を精算に含める／除外する業務ルールの正式決定（コード上は送料非集計）
5. POS キャンセルと Admin キャンセルを件数上どう区別すべきか（コード上区別なし）
6. `ReceiptIssue.createdBy` を運用で埋めるか
7. line item properties を精算／領収書に出す要件の有無
8. ギフトレシート（Shopify Gift Receipt）要件の有無（現行未実装）
9. ~~Admin API October25 と webhook 2026-04 の併用方針~~ → Admin も 2026-04 にそろえた。残る未確認: POS 内から直接呼ぶ Admin GraphQL が答える版
10. 死コード（refund overlay）削除の是非
11. 点検 DoneView 文言と order_based 同期のどちらを仕様とするか
12. 精算設定の表示項目名を印字テキストへ反映する要件の有無
13. `cloudprntPaperWidth` キー名の完全廃止タイミング（現状は `paperWidthMm` 同期）

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

## 9. POS 拡張で使える部品（2026-11-23）

- **POS の UI 拡張では `@shopify/ui-extensions` の point-of-sale にある部品だけを使う**。`s-select`・`s-option`・`s-checkbox` は POS に無く、エラーも出さずに何も描かれない。2843ee7（2026-03-10）から特殊返金の「返金種別」「元の支払手段」「実際の返金手段」「調整種別」が `s-select` で、選ぶ欄が出ないまま初めの値（現金返金・現金）で登録されていた。精算のロケーション選択（`s-select`）と領収書の「再発行として記録する」（`s-checkbox`）も同じく出ていなかった。
- 1 つを選ぶ欄は `extensions/pos-smart-grid/src/PosChoiceField.jsx` の `PosChoiceField`（`s-choice-list`）、オン・オフは `PosToggleField` を使う。精算のロケーションは年・月と同じくボタンで開く一覧にした。
- `scripts/lib/posExtensionComponents.test.mjs` が POS の拡張（target がすべて `pos.` の拡張と `extensions/common`）のソースを見て、POS に無い部品があると落ちる。部品の一覧は `@shopify/ui-extensions` 2025.10.x のもの。版を上げたら一覧を見直す（版が変わると試験が落ちて知らせる）。
- POS の実機ではまだ見ていない（選ぶ欄の見た目・押したときの動きは実機で確かめる）。
