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
3. 集計バケットキーは `gasNormalizeGatewayLabel` で日本語ラベル化（現金・クレジット・QR・交通系 IC・商品券系・PayPal・それ以外）
4. 表示ラベルは `resolvePaymentSectionLabel`（`paymentMethodMatch.server.ts`）で `PaymentMethodMaster` を参照。raw / formatted / displayLabel のいずれかに一致すれば `displayLabel` に差し替え（英数字キーに限らない）
5. 現金は **cash cap**: `effectiveCashSale = min(生現金, max(0, 注文合計 − 非現金))`
6. REFUND TX が無く refund オブジェクト金額のみある場合 → バケット `"未分類"` に加算

カスタム決済: マスタ未一致時は `formattedGateway` または raw gateway、それも無ければ未分類ラベル。集計キー自体のハードコード日本語は残る（表示のみマスタ単一化）。

---

## 4. 割引・VIP

- 行の `discountAllocations` を走査
- `DiscountCodeApplication` かつコードが `VIP-` で始まる（大文字化比較）→ `vipPointsUsed`
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

精算集計では、解決 GID が精算対象ロケーションと一致しない返金は **件数・金額とも加算しない**。  
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

---

## 8. スタッフ名

- 注文詳細 API が lineItems の `staffMember` を `staffMemberName` として返す
- POS 詳細 UI で「販売: …」表示
- 精算集計・精算レシート文言・領収書金額計算には **未使用**
- `ReceiptIssue.createdBy` は API で受け取れるが、POS `receiptApi.js` は送っていない

---

## 9. line item attributes / properties

- `customAttributes` は注文詳細で取得・シリアライズされる
- `OrderDetailSummary` は表示しない
- 精算集計は quantity と discountAllocations を使用（customAttributes 不使用）

---

## 10. 特殊返金の精算反映

`SpecialRefundEvent`（当日・同一ロケーション・status=active）を設定フラグに従い反映:

| eventType | 反映内容（概略） |
|-----------|------------------|
| `cash_refund` | 返金額を支払セクション／refundTotal 等へ（設定 `reflectCashRefundToSettlement`） |
| `receipt_cash_adjustment` | undo/extra に応じ増減（設定依存） |
| `payment_method_override` | 実際の返金手段側へ寄せる（設定依存） |
| `voucher_change_adjustment` | `voucherChangeAmount` に加算（設定依存） |

反映後に税・net の再計算ロジックあり（エンジン後半）。

---

## 11. 商品券・レガシー Gift Card

- ゲートウェイ正規化で商品券／釣有り／釣無しを分類
- 注文ノートの「商品券 N円」から額面観測（キャンセル除外）
- `legacyGiftCardAggregationEnabled` が **true のときのみ** Gift Cards API 発行分を加算（**既定 OFF**。POS union に含まれる order は二重加算回避）。失敗時は加算せず続行

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
| 精算 create | `idempotencyKey = shopId:locationId:targetDate:printMode`。既存なら新規 Settlement を作らず返す。order_based 時は Shopify 再同期しうる |
| 点検 | 冪等キー対象外 |
| 同時実行 | `SettlementOperationLock` |
| 領収書 | クライアント UUID `idempotencyKey` |
| 精算 recalculate | プレビュー再計算＋任意の Shopify 同期。履歴行の金額を常に書き換えるわけではない（API 実装参照） |

---

## 16. タイムゾーン

日次境界は Shopify `shop.ianaTimezone`（フォールバック: 一般設定 defaultTimezone）で UTC 範囲に変換（`shopTimezone.server`）。
