# BUSINESS_RULES — 現行業務ルール（コード確認済み）

本ファイルは **現行コードで確認できる仕様のみ** を記載します。要件書の希望仕様や古い調査メモと食い違う場合は、ここに書いたコード挙動を優先し、差分は `DECISIONS.md` に記録します。

根拠の中心: `app/services/settlementEngine.server.ts`, `refundAggregation.server.ts`, `settlementOrderGas.server.ts`, `api.settlements.create.tsx`, `api.orders.search.tsx`, `planFeatures.server.ts`。

---

## 1. 注文の取得範囲（精算・売上サマリー）

### 1.1 精算・売上サマリー（店舗日次の正）

精算プレビュー（売上サマリーも `buildSettlementPreview` を再利用）:

1. `location_id:{数値}` + ショップ TZ の当日 UTC 範囲で次を **union（注文 id 重複排除）**
   - `created_at` かつ `-status:cancelled` かつ `tag_not:settlement`
   - `updated_at` かつ `-status:cancelled` かつ `tag_not:settlement`
   - `updated_at` かつ `status:cancelled` かつ `tag_not:settlement`
2. **`source_name:pos` は付けない**（D1: GAS 同型。注文検索とは意図的に異なる）
3. **retailLocation による二次フィルタはメイン集計では行わない**
4. 結果が空のとき `processed_at` 当日のフォールバッククエリあり
5. タグに `settlement`（大小無視）がある注文は集計から除外

**境界の要約**: 精算の一次フィルタは **Shopify の `location_id` + 日付**。POS 端末ソースや retailLocation での再絞り込みはしない。返金の店舗帰属は別途 §5（解決 GID と精算ロケの数値 ID 照合）。

### 1.2 注文検索（領収書・特殊返金のピッカー）

- `locationId` 指定時は `location_id` **かつ** `source_name:pos`
- 返却前に retailLocation がそのロケーションのものに絞り込み

### 1.3 販売チャネル集計（`salesChannelEngine`）

- POS 系 `source_name` を除外して非 POS を扱う

---

## 2. orders（件数）と items（点数）

| 指標 | 意味（精算ヘッダ） |
|------|-------------------|
| `orderCount` | 当日の実効売上（現金キャップ後）−（計上対象の当日返金）が **> 0** の注文の件数（`saleOrderSet.size`） |
| `itemCount` | 実効売上 > 0 の注文の lineItems 数量合計 − 計上対象返金の `refundLineItems.quantity` |
| `refundCount`（ヘッダ） | 計上対象の返金活動があった **注文数**（`refundOrderSet.size`）。Refund オブジェクト数ではない |

支払方法セクション側の `refundCount` は **REFUND トランザクション件数**（`refundTx`）であり、ヘッダの注文数とは定義が異なる。

---

## 3. 決済方法別集計

1. 当日対象 TX: `tx.createdAt` が当日、または当日 refund オブジェクトにリンクする REFUND
2. `SALE` / `CAPTURE` → sale、`REFUND` → refund（計上ロケーション一致時のみ）
3. 集計バケットキーは「精算の数え方」の「支払方法の分け方」で決める。初めの値は `gasNormalizeGatewayLabel` で日本語ラベル化（現金・クレジット・QR・交通系 IC・商品券系・PayPal・それ以外）。「支払方法マスタで分ける」店は、当たったマスタの表示名がキー（当たらない取引は `gasNormalizeGatewayLabel`。`docs/SETTLEMENT_CALC_SETTINGS.md`）
4. 表示ラベルは `resolvePaymentSectionLabel`（`paymentMethodMatch.server.ts`）で `PaymentMethodMaster` を参照。raw / formatted / displayLabel のいずれかに一致すれば `displayLabel` に差し替え（英数字キーに限らない）
5. 現金は **cash cap**: `effectiveCashSale = min(生現金, max(0, 注文合計 − 非現金))`。現金の行は、決まった分け方では「現金」、マスタで分ける店では種類が現金のマスタの行
6. REFUND TX が無く refund オブジェクト金額のみある場合 → バケット `"未分類"` に加算

カスタム決済: マスタ未一致時は `formattedGateway` または raw gateway、それも無ければ未分類ラベル。初めの値（決まった分け方）では集計キー自体のハードコード日本語は残る（表示のみマスタ単一化）。「支払方法マスタで分ける」を選んだ店は、集計キーも表示もマスタの表示名に一本化される。

---

## 4. 割引・VIP

- 行の `discountAllocations` を走査
- 次の割当 → `vipPointsUsed`（精算の「ポイント利用額」）。見分け方は `app/utils/pointRedemptionRules.ts`、設定は「ポイント/会員施策設定」の「精算のポイント利用額に数える割引」（`loyalty_settings` の `pointRedemption*`）
  - `DiscountCodeApplication` で、コードが設定の頭のどれかで始まる（大文字化比較）。初めの値は `VIP-`（旧 VIP）と `SP-POINT-`（Shop Point のオンラインの顧客専用コード）
  - `DiscountCodeApplication` で、Shop Point の旧形式（`SP` ＋ 16 桁の 16 進）。初めの値は数える（設定で切れる）
  - コードの無い `ManualDiscountApplication` / `ScriptDiscountApplication` で、名前が設定の名前のどれかと一致（前後の空白を除き、半角英字の大小は区別しない）。初めの値は `Shop Point`（POS のカートの割引）。自動割引は同じ名前でも数えない
  - 保存していない店・保存値が壊れている店は初めの値で数える。「ポイント利用額を有効にする」「抽出元」の設定や前からの欄 `loyaltyUsageDiscountCodePrefixes` は精算では使わない
- それ以外の割当 → `discounts`
- いずれも `keepRatioToday = max(0, 実効売上 − 当日返金) / 実効売上` で按分し `Math.round`
- GraphQL で取る `totalDiscountsSet` は、この VIP/割引合計には **未使用**（取得していても集計式は allocations 経路）

ポイント系特殊返金の `originalPaymentMethod === "points"` 等の VIP 合成はコメント上「後続フェーズ」とあり、現行 `vipPointsUsed` は上記割引コード按分が正。

---

## 5. 返金の計上ロケーション

設定キー（精算設定）:

- `refundAggregationLocationMode`: `order_transaction`（既定）\| `refund_transaction_pos_location`
- `nonPosRefundFallbackMode`: `order_retail_location`（既定）\| `exclude`
- Location フラグ `nonPosRefundAttributionEnabled`（ショップ内最大 1 件想定）

解決順（`resolveRefundAggregationLocationGid`）:

1. モードが refund TX POS ロケーション優先かつ POS ロケーション取得可 → その GID
2. 返金 TX に POS ロケーションあり → retailLocation 優先、なければ返金 TX ロケーション
3. POS ロケーションなし（管理画面返金等）→ `nonPosRefundAttributionEnabled` 先があればそこ
4. なければ fallback: exclude なら null（精算に載せない）／さもなくば retailLocation

精算集計で使う計上先（`decideRefundAttributionForSettlement`）:

- 注文基準（`order_transaction`・既定）: 上の解決順の結果だけを使う。注文の metafield `pos.refund_aggregation_location_gid` は不一致のログ（`refundAttributionMismatchCount`）にだけ使う。別の店で登録した特殊返金が metafield を書き換えても、通常の返品の計上先は変わらない
- 返金基準（`refund_transaction_pos_location`）: 当日の返金 TX の POS ロケーション → metafield → 上の解決順
  - 別の店で売った注文の、この店での返金も拾う（`mergeCrossLocationRefundOrders`）。ただし **この店の注文取得（`location_id`）にすでに入っている注文は足さない**。足すと、売上を持った元の注文が返金だけの入力で上書きされ、その日の売上が消える（#11 の見直し P1-1。合成データで 9,000 円が −1,000 円）。元の注文は返金 TX ごとに店を見て数えるので、それで足りる

精算集計では、計上先が精算対象ロケーションと一致しない返金は **件数・金額とも加算しない**。  
照合は `locationGidMatches` で **数値ロケーション ID 同士**（GID / 数値 / 末尾パスの表記ゆれを吸収）。

---

## 6. キャンセル注文

- 当日 `updated_at` の **cancelled** 注文は union に含める
- キャンセル済みでは商品券ノート額面の観測（`observeVoucherFace`）を行わない
- POS キャンセルと Admin キャンセルの **起源区別ロジックは精算集計にない**（未確認／未実装）

---

## 7. 配送注文・送料

- 精算集計 GraphQL／合計に顧客注文の送料（`totalShippingSet` 等）を加算する処理は **ない**
- 精算用内部 line item は `requiresShipping: true`（履行して閉じる用途）。点検は `false`
- 配送注文を特別扱いする業務分岐は **コード上未確認（見当たらない）**

### 7.1 売上に含めない送料等の明細（`_lsi_fee`）

Location Stock の POS Lite 配送では、送料が注文の配送料でなく **商品の 1 行（カスタム売上）** で入る（b3inc-dev/location-stock-indicator#76）。明細の属性で見分ける（`app/services/nonSalesFeeLines.ts`）。名前（「送料」）では見分けない。

| 明細の属性 | 扱い |
|---|---|
| `_lsi_fee="1"` かつ `_lsi_fee_sales="0"` | **売上に含めない**（下の表） |
| `_lsi_fee="1"` かつ `_lsi_fee_sales` が `"0"` 以外・無し | 今までどおり普通の明細として数える |
| `_lsi_fee` が無い | 普通の明細 |

売上に含めない明細の扱い:

- **支払方法別の金額（paymentSections）はそのまま**（お客さまから受け取ったお金。現金の納金額と合わせるため）
- **総売上 `total` = 支払方法別の合計 − `nonSalesFeeTotal`**。純売上・消費税（`total` から逆算）も同じく外れる。売上サマリーの `actual` は精算の `netSales` なので同じく外れる（D2）
- `nonSalesFeeTotal` = 当日売った送料の行の金額（割引後。税抜価格の店は税込に直す。分けて払った注文は当日の支払の割合で按分）− 計上対象の当日返金に入った送料の行（`refundLineItems.subtotalSet`）。あとの日に送料だけ返金するとその日はマイナス（売上を減らさない）
- 点数 `itemCount` に数えない（返金の点数も引かない）。送料の行に配られた割引は「割引」「ポイント利用額」に数えない。`taxShopify` から送料の行の税を引く
- 精算画面（POS）・精算レシートの印字に「売上に含めない送料等」を出す（0 なら出さない）。保存済みの精算は DB に列が無いので、印字のとき「支払方法別の合計 − 総売上」で戻す（総売上 0 の日は 0）
- 領収書（プレビュー・発行）の金額は **受け取った全額のまま**（注文の合計。送料の行も含む。T 2026-11-23）
- 値は会計のときの設定（Location Stock 側）。あとから設定を変えても前の注文は変わらない
- 販売チャネル別集計（`salesChannelEngine`、POS 以外）・order_based の精算注文メタフィールドには未対応（POS Lite の配送は POS 注文なので精算側で外れる）

---

## 8. スタッフ名

- 注文詳細 API は lineItems の `staffMember` を読まない（`read_users` が要り、無い店では注文の取得ごと 500 になるため。`read_users` は足さない）。`staffMemberName` は今は空で返し、POS 詳細 UI の「販売: …」は出ない
- 帰属スタッフはアプリの記録（orders/create・orders/updated の `attributed_staffs`）から入れる形を #84 で別に進めている
- 精算集計・精算レシート文言・領収書金額計算には **未使用**
- `ReceiptIssue.createdBy` は API で受け取れるが、POS `receiptApi.js` は送っていない

---

## 9. line item attributes / properties

- `customAttributes` は注文詳細で取得・シリアライズされる
- `OrderDetailSummary` は表示しない
- 精算集計は quantity と discountAllocations を使用。customAttributes は売上に含めない送料等の見分け（§7.1）だけに使う

---

## 10. 特殊返金の精算反映

記録の置き場所（D25）: 特殊返金・商品券調整は、店の設定（特殊返金設定「注文への記録」、初めはオフ）がオンなら注文メタフィールド `pos.adjustments` にも残す（`docs/ORDER_ADJUSTMENTS_METAFIELD.md`）。精算はいつもアプリの記録でその日・その店の有効な行を数え、注文の値が違えば書き直す。数える日は行の `countDate`（店のタイムゾーン）で、前からの行（`countDate` なし）は登録した日。商品券のお釣りは注文の日。直すときは「変更」（前の行を無効にして置き換えの行を足す。Shopify の返金はしない）。

`SpecialRefundEvent`（当日・同一ロケーション・status=active）を設定フラグに従い反映:

| eventType | 反映内容（概略） |
|-----------|------------------|
| `cash_refund` | 返金額を支払セクション／refundTotal 等へ（設定 `reflectCashRefundToSettlement`） |
| `receipt_cash_adjustment` | 記録だけ（Shopify では返金しない。T 決定 2026-11-23）。`undo`＝返金を取り消して売上に戻す（返金の合計と支払方法の行の返金から引く）、`extra`＝現金を売上に足す |
| `payment_method_override` | 実際の返金手段側へ寄せる（設定依存） |
| `voucher_change_adjustment` | `voucherChangeAmount` に加算（設定依存） |

反映後に税・net の再計算ロジックあり（エンジン後半）。

Shopify 返金の状態（`shopifyRefundStatus`）による扱い:

| 状態 | 精算での扱い |
|------|--------------|
| `success` | Shopify の REFUND TX が正本。金額は足さず、元の手段から実際の手段へ振り替えるだけ |
| `pending` | Shopify 返金を実行したが成否が分からない（タイムアウト等で再試行待ち）。**上乗せも振替もせず、精算・点検・売上サマリーの日次を確定しない**（`SpecialRefundPendingError`、API は 409）。店の人は Shopify 管理画面で返金の有無を確かめてから、POS の特殊返金の登録の「Shopify 返金を確かめる」を押す（同じ冪等キーで API を呼び直す。サーバーは返金ノートの印を探し、無ければ同じキーの `refundCreate` を呼ぶので 2 回にならない）。POS の日別一覧には「返金未確認」のバッジが出る。**前からある登録（ID が `pos_sr_` で始まらない）** も同じボタンが出るが、こちらは `POST /api/special-refunds/:id/recheck` で Shopify の注文の返金を読み直すだけで、**返金は実行しない**（main のときの返金には冪等キーも印も無く、もう一度実行すると 2 回返金になりうるため）。印・「特殊返金」のノート・種別・金額が合う返金が 1 件だけなら `success`、無いか迷うときは店の人が候補から選ぶか「Shopify に返金はありません」（`failed`。この登録らしい返金があるときは受けない）を選ぶ。どちらも決める直前に Shopify を読み直す。無効化や登録し直しは、二重返金・二重計上になりうるので案内しない。反映の設定がオフの種別は止めない |
| `failed` / `skipped` / `none` | Shopify 返金は無い前提で、上の表どおりアプリの金額を足す |

**POS 純正の返金の付け替え（D27）**: 純正で返金した注文では、純正の返金を選んで金額はそのまま手段だけ付け替える（分割は何行でも・最後の行は残額）。登録は `refundSource=native`・`shopifyRefundStatus=success`・`shopifyRefundId`＝純正の返金なので、上の表の `success` のとおり元の手段から実際の手段へ移すだけ。数える日は純正で返金した日。Shopify では返金しない。返金の残りを超える登録は断る。

実際の返金手段（`cash_refund`・`payment_method_override`）は **支払方法マスタ（有効・「特殊返金で選べる」）からだけ選べる**（T 決定 2026-11-22）。POS の選択肢はマスタだけ（注文の決済手段や既定の候補は足さない）で、マスタが空・読めないときは登録できない。`POST /api/special-refunds` も新しい登録ではマスタの値（`rawGatewayPattern`、大文字小文字・空白の違いは同じ）以外を 400（`REFUND_METHOD_NOT_IN_MASTER`）で断る。同じ冪等キーの呼び直し（「Shopify 返金を確かめる」）は、あとでマスタを変えても止めない。元の支払手段は注文の決済手段のままでよい。

前からある登録で返金方法がマスタに無いとき（マスタから消した、上の決まりより前の登録）の精算の受け皿:

| 場面 | 精算での扱い |
|------|--------------|
| `cash_refund`・`payment_method_override` の返金方法がその日の支払方法の行に無く、マスタ（`enabled`）にも既定の名前（`cash` など）にも無い | 「未分類」の行に載せる（その日に Shopify の未分類の行があれば同じ行）。**合計・返金合計は変わらず、精算は確定できる**。POS の精算画面に警告、精算履歴に「未分類あり」のバッジを出す |
| 返金方法がマスタにあり、その日の行が無い | マスタの表示名で行を作る（前は手段のコードがそのまま行名になっていた） |
| `success` で元の支払方法の行がその日に無い | 二重に引かないよう付け替えはしない（前と同じ）。警告だけ出す |
| `receipt_cash_adjustment` の支払方法の行がその日に無い | 金額の扱いは前と同じ。警告だけ出す |

マスタに登録して「更新」すれば、次の集計から正しい行に入る。確定済みの精算の行は変わらない。

「マスタで分かる」の決め方は、登録と精算で違う（わざと）:

- 登録（POS・`POST /api/special-refunds`）: 有効で「特殊返金で選べる」のマスタだけ（値 `rawGatewayPattern` の一致）
- 精算の受け皿（`isKnownRefundMethod`）: 有効なマスタ全部（`rawGatewayPattern`・`formattedGatewayPattern`・表示名の一致、集計キーに寄せた名前でも）と既定の名前（`cash`・`shopify_payments`・`manual` など）。前の登録をなるべく正しい行に入れ、どこにも当たらないものだけを「未分類」にするため

精算履歴の「未分類あり」は、保存した `paymentSectionsJson` の「未分類」の行（金額が 0 でない）で出す。前の形（行の配列）と #22 の形（`{ format, snapshot, sections }`）のどちらも読む。

`pending` を止める理由: 数えると Shopify 側で返金ができていたとき二重（監査の合成データで 1,000 円が 2,000 円）、数えないとできていなかったとき抜ける。Shopify 側の返金ノートには `[POS_RECEIPT_EVENT:<イベントID>]` が入るが、精算の注文取得は返金ノートを読んでいないため、精算の中では成否を確かめていない。

**自動の確定（D23・T 2026-11-23 4:25）**: 最後に返金を試してから 5 分たっても `pending` の登録は、アプリが自動で Shopify の注文の返金を読み直して決める。**読むだけで、返金は作らない**。

| 登録 | Shopify に印 `[POS_RECEIPT_EVENT:<ID>]` の返金がある | 無い |
|------|------|------|
| `pos_sr_`（冪等キーあり） | `success`（その返金に紐づける） | `failed`（「自動確認: … Shopify にこの登録の返金はありません」） |
| 前から（`pos_sr_` 以外） | `success` | 「特殊返金」のノート・種別・金額が合う返金がちょうど 1 件なら `success`。それ以外は `pending` のまま（店の人が「Shopify 返金を確かめる」で選ぶ） |

- いつ: 精算プレビュー・点検・確定の集計の最初（その日・その店の登録）、POS の特殊返金の一覧を開いたとき（その注文の登録）、5 分ごとの見回り（`pos_sr_` の登録・全店。pg-boss。売上サマリーのキューが無効のときは動かない）。
- Shopify の注文を読めなかったときは `pending` のまま（次に回す）。
- 決めたあとは、POS で決めたときと同じく返金の計上ロケーションのメタフィールドを書き、売上サマリーの日次を作り直す（精算の集計の中から決めたときは、その集計の結果を使うので作り直さない）。
- 自動で `failed` にした登録（エラーが「自動確認:」で始まる）は、POS の「もう一度実行」で同じキー・同じ内容が送られたら `pending` に戻し、同じ冪等キーで Shopify の返金をやり直す（返金は 1 回だけ）。無効化済みの登録や、ほかの理由の `failed` はやり直さない。
- 環境変数: 自動の確定は**既定でオフ**。`SPECIAL_REFUND_AUTO_RESOLVE=1`（true / on）のときだけ動く（開発ストアで確かめてから T さんがオンにする）。`SPECIAL_REFUND_AUTO_RESOLVE_AFTER_MINUTES` で何分後に決めるかを変える（既定 5、2〜1440）。

### 返金手段変更の管理者の承認（設定でオンのときだけ）

特殊返金設定「管理者の承認」（`requireApprovalForPaymentMethodOverride`）は**初めはオフ**で、オフの店は今までどおり登録した時点で精算に入る。オンの店では、返金手段変更（`payment_method_override`）だけを承認待ち（`approvalStatus=pending`）で登録する。ほかの種別は承認の対象外（`none`）。

| 承認の状態 | 精算・点検・売上サマリー |
|------------|--------------------------|
| `none`（対象外・前からの登録）・`approved`（承認済み） | 上の表どおりに数える |
| `pending`（承認待ち） | 数えない。精算画面（POS）と点検に「承認待ちが N 件」の警告を出す。精算は確定できる |
| `rejected`（却下） | 数えない。警告も出さない |

- 承認・却下は管理画面「特殊返金・商品券調整 履歴」の行のボタンから（確認の窓のあと）。承認待ちのときだけ書き換える（二人が同時に押すと後の人は断る）。却下から承認には戻せない。決めたら登録日の売上サマリーのキャッシュを計算し直す。登録日の精算がもう確定していれば、確定した金額は変わらないので POS の精算で再確定する（D21）。
- Shopify には書かない。「POS 登録時に Shopify で実返金」の店は、登録した時点で今までどおり Shopify の返金を実行する。承認待ち・却下のあいだは、その返金は Shopify の返金の行（元の支払方法）に数えられたままで、付け替え（元の手段から実際の手段へ）だけをしない。記録のみの店は、承認待ち・却下のあいだその返金の金額は精算に入らない。
- 承認待ちでも Shopify 返金の成否が分からない（`shopifyRefundStatus=pending`）ものは、上の `pending` の決まりどおり精算の確定を止める（Shopify 側に返金がありうるため）。
- 決めた人は DB（`approvalDecidedBy`）にだけ残し、履歴の画面に決めた日時と一緒に出す（T の決定 2026-11-23 16:20）。このアプリは管理画面をオフラインのセッションで動かすので、ふつうは App Bridge のセッショントークンの `sub`（Shopify のユーザー ID）を `shopify_user:<ID>` で残し、画面には「ユーザー ID <ID>」と出す（名前を読むには `read_users` が要るので読まない）。オンラインのセッションなら名前（無ければメール）。どちらも取れないとき（埋め込みでない開き方など）は空のまま。注文に書く値（`pos.adjustments`）には入れない。
- 無効化（POS）は承認の状態に関係なくできる。

### 返金の予約（設定でオンのときだけ）

特殊返金設定「返金の予約」（`refundReservationEnabled`）は**初めはオフ**。オンの店では、POS 純正で返金する前に、返金する金額と実際に返す手段（分割可）を注文に予約できる。予約した日のうちにできた純正の返金で、返金額が予約の金額と同じときだけ、純正の返金の付け替え（金額固定・Shopify では返金しない）を自動で作る。違うとき・返金が複数の支払方法に分かれたときは作らずに「要確認」にし、返金タイルの一覧から付け替える。詳しくは `docs/REFUND_RESERVATION.md`（D29）。

---

## 11. 商品券・レガシー Gift Card

- ゲートウェイ正規化で商品券／釣有り／釣無しを分類
- 注文ノートの「商品券 N円」から額面観測（キャンセル除外）
- `legacyGiftCardAggregationEnabled` が **true のときのみ** Gift Cards API 発行分を加算（**既定 OFF**。POS union に含まれる order は二重加算回避）。取得が途中で失敗したとき（GraphQL errors・ページ情報の欠け・例外）は途中までの額で続けず `UpstreamAggregationError` で止め、精算・売上サマリーを確定しない（注文の取得と同じ考え方）。主クエリが errors のときだけ、新しい順の全件走査で最初から数え直す

---

## 11.1 税・純売上（正と診断）

- **正（印字・精算プレビューの `tax` / `netSales`）**: 支払ネット合計を精算設定の `taxRatePercent`（既定 10）で税込逆算（`splitTaxInclusiveToNetAndTax`）
- **診断（`taxShopify`）**: 注文税 × keepRatio。印字・精算の主値には使わない
- 税・決済ラベルの全面再設計は別 workstream（本節は現行の正を固定するのみ）

---

## 12. 領収書表示ルール

- 金額: 注文 `totalPriceSet`
- 宛名・但し書き（既定「お買上品代として」）・再発行フラグ
- ロケーション: 注文の `retailLocation`
- テンプレ: 有効な `ReceiptTemplate`
- 発行は DB 記録が主。プリンタ送信なし

---

## 13. 精算レシート表示

`buildSettlementReceiptText` は日本語固定ラベルで total / net / tax / 割引 / 返金 / 件数 / 点数 / 支払別を出力。精算設定の項目名カスタムは **このテキストビルダでは未使用**。

order_based の Shopify 注文ノート／metafields は `settlementOrderGas` が別途構築。

---

## 14. プラン依存（アプリ課金）

`planFeatures.server.ts`:

| 機能 | Lite | Pro+ |
|------|------|------|
| 精算・特殊返金・領収書 | 可 | 可 |
| 売上サマリー・入店数・予算 | 不可 | 可 |

無制限: `APP_DISTRIBUTION=inhouse` / `CUSTOM_APP_STORE_IDS` / 開発ストア / planCode `unlimited`。

**Shopify POS Pro / Light** プランを参照する分岐はコードに **見当たらない**（未確認＝依存なしと断定せず、検出なしと記載）。

---

## 15. 冪等・再実行

| 操作 | ルール |
|------|--------|
| 精算 create | `idempotencyKey = shopId:locationId:targetDate:printMode`。既存なら新規 Settlement を作らず、**集計し直さずに DB の確定値を返す**（応答 `confirmed: true`）。Shopify の精算注文・売上サマリーのキャッシュは書き換えない（D21） |
| 精算 再確定 | create に `reconfirm: true`。集計し直し、数が同じなら何も変えない（`reconfirmed: false`）。変わっていれば新しい行を確定値にし、前の行は `superseded`（履歴に「再確定前」）。order_based は精算注文も直す。POS は「更新」で数が変わったと分かった日に「今の数で再確定する」を出す（D21） |
| 点検 | 冪等キー対象外。発行ごとにその時点の金額と支払方法別内訳を保存する。返金処理中の特殊返金があっても警告つきで出す（D21）。月別一覧ではその日の精算として扱わない |
| 同時実行 | `SettlementOperationLock` |
| 領収書 | クライアント UUID `idempotencyKey` |
| 特殊返金 | POS が `idempotencyKey` を送る → 登録の ID は `pos_sr_<キー>`、Shopify の `refundCreate @idempotent` にも同じ ID。**移行期間はキー無しも受ける**（古い POS の拡張。`console.warn` を残し、main と同じく登録ごとに新しい ID を作り、その ID を Shopify の冪等キーに使う）。不正な形のキーは 400。出す順番は `DEPLOY_PUBLIC_AND_INHOUSE.md` §4.1 |
| 精算 recalculate | 確定前の日: プレビュー再計算＋任意の Shopify 同期（従来どおり）。**確定済みの日**（点検以外の Settlement が `completed` / `printed`）: `preview` は DB の確定値（`confirmed: true`）。比べるために 1 回集計し、違えば `changedSinceConfirm: true`・`changedFields`・`livePreview` を返す。Shopify の精算注文と Settlement 行は書き換えない（D21） |

---

## 16. タイムゾーン

日次境界は Shopify `shop.ianaTimezone`（フォールバック: 一般設定 defaultTimezone）で UTC 範囲に変換（`shopTimezone.server`）。

## 17. 精算の数え方（店ごとの設定）

売上を数える日・点数に数えない商品・返金の支払方法の付け替え・ギフトカードの返金・支払方法ごとの取引件数・マイナスの日の合計は、管理画面「精算の数え方」で店ごとに選ぶ。初めの値は上の 1〜16 の動きのまま。詳しくは [SETTLEMENT_CALC_SETTINGS.md](SETTLEMENT_CALC_SETTINGS.md)。
