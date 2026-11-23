# GAS 実装と pos-receipt アプリ実装の比較・ギャップ一覧

要件書を正本とし、GAS は CloudPRNT 非対応のみの参考実装として、今回のアプリで **CloudPRNT 対応を追加** する前提で比較しました。  
ロケーション名や自社用の調整は、管理画面から各社ごとに設定できる想定です。

> **2026-11-22 更新（main `77b6de6` のコードで確認）**: 本書は 2026-03 の比較メモ。その後、精算は GAS 型の集計（`app/services/settlementAggregatePure.server.ts` の `aggregateGasStyleForOrders`）に置きかわり、売上サマリーも精算プレビュー（`buildSettlementPreview`）を使うようになった。そのため §7.2・§7.3・§7.4 の税率と、§8.1〜§8.7 の「POS（アプリ）」の列が古くなっていたので、今の動きに書き直した。印字は main で Shopify Printing API を先に試す形になり、精算注文（order_based）と CloudPRNT は旧経路として残る（一本化は PR #22）。業務ルールの正本は `docs/BUSINESS_RULES.md`。ciara-system との違いは本書の対象外。

**実装済み（2026-03 対応）**  
- 1.1・1.2: 日次集計のタイムゾーンを Shopify の `shop.ianaTimezone`（フォールバック: 一般設定の defaultTimezone）で算出し、精算・売上サマリー・特殊返金イベントの対象日に適用。  
- 1.3: 返金の再集計（別パス）を実装。その日に `updated_at` で更新された注文を取得し、`refund.createdAt` がその日かつ「その日作成」でない注文の返金のみをオーバーレイして payment sections と refundTotal / refundCount にマージ。（2026-11 現在: 注文のユニオンのメインループで返金を数えるので、オーバーレイは使っていない。§8.1・§8.3）  
- 1.4・1.5: 特殊返金イベント（cash_refund / receipt_cash_adjustment undo・extra / payment_method_override）を精算の total・refundTotal・paymentSections に反映。  
- **§7.1**: 精算注文は `order_based` のときのみ作成し、`cloudprnt_direct` のときは作成しない（api.settlements.create で分岐済み。コメントでガイド 8.1 を明記）。  
- **§7.2**: 返金・特殊返金反映後に税・net を再計算（2026-11 現在: 支払方法別の合計から total を出し、精算設定の消費税率で税込みとして tax / netSales に分ける）。  
- **§7.3**: 売上サマリーの actual を純売上に変更（2026-11 現在: 精算プレビューの netSales をそのまま使う）。

---

## 1. 意図とずれている／未対応の箇所

### 1.1 日次集計のタイムゾーン（JST 基準になっていない） ✅ 対応済

**GAS の意図**  
- 日次集計は **JST の 00:00〜23:59** を基準とする（`jstDayAsUtcRange` で JST 境界を UTC に変換してクエリ）。

**現在の実装**  
- 精算: `created_at:>=${targetDate}T00:00:00 created_at:<=${targetDate}T23:59:59` でクエリ（タイムゾーン指定なし）。
- Shopify の `created_at` は **UTC** のため、この書き方だと **UTC の 0:00〜24:00** で集計されている。
- 日本時間では、前日 15:00 〜 当日 14:59（UTC）＝ 当日 0:00 〜 23:59（JST）にしたいが、現状は **当日 9:00（JST）〜 翌日 8:59（JST）** のようなずれが発生しうる。

**影響**  
- 精算・売上サマリーの「その日」の範囲が、GAS／業務イメージ（JST 日付）と一致しない可能性がある。

**推奨**  
- 日次集計時は、**Shopify のショップ設定（国・タイムゾーン）** からタイムゾーンを取得し、そのタイムゾーンの「その日 00:00〜23:59」を UTC 範囲に変換してから `created_at` クエリを組み立てる。  
- Shopify GraphQL の `shop { ianaTimezone }`（IANA 形式、例: `Asia/Tokyo`）を使う。取得できない場合は一般設定の `defaultTimezone` にフォールバックする。  
- これにより、日本以外の国で利用する場合も、各ショップの設定に合わせた日付境界で集計できる（汎用設計）。

---

### 1.2 特殊返金イベントの「対象日」が UTC になっている ✅ 対応済

**GAS の意図**  
- 精算に含める特殊返金・商品券調整は「その日（JST）」に登録されたものを対象にする想定。

**現在の実装**  
- `SpecialRefundEvent` の取得で  
  `createdAt: { gte: new Date(\`${targetDate}T00:00:00.000Z\`), lte: new Date(\`${targetDate}T23:59:59.999Z\`) }`  
  としているため、**UTC の 0:00〜24:00** でフィルタしている。

**推奨**  
- 1.1 と同様に、Shopify のショップタイムゾーン（`shop.ianaTimezone`）で「その日」の 00:00〜23:59 を UTC に変換し、`createdAt` をその UTC 範囲でフィルタする。

---

### 1.3 返金の「再集計」（refund 別パス） ✅ 対応済

**GAS の意図**  
- 返金は「当日売上だけ」の集計では漏れうるため、**返金トランザクションを別パスで再集計**する（`computeRefundsOnlyForDay`、`overlayRefundsAndRecalc`）。
- 注文の `updated_at` や refund の日付を踏まえ、「その日に処理された返金」を payment 別に上書きし、total / tax / net を再計算する。

**実装内容**  
- その日の **注文** を `created_at` で取得したうえで、**その日に `updated_at` で更新された注文**を別クエリで取得（`REFUNDS_ORDERS_QUERY`、`refunds.createdAt` 含む）。
- 「その日に作成された注文」に含まれない注文についてのみ、`refund.createdAt` がその日（ショップタイムゾーンで算出した UTC 範囲）の返金を集計し、`computeRefundsOnlyForDay` でオーバーレイを算出。
- `mergeRefundOverlay` で payment sections と refundTotal / refundCount にマージし、二重計上を避けている。
- 2026-11 現在: 上のオーバーレイは精算・売上サマリーとも使っていない（`overlayRefundCount` は常に 0）。その日の返金は created ∪ updated のユニオンのメインループで数える（§8.1・§8.3）。

---

### 1.4 特殊返金イベントが精算の合計・payment sections に反映されていない ✅ 対応済

**GAS の意図**  
- **現金返金（Gift Card の create→deactivate）**: 精算の「現金」の返金に加算し、`refund_total` を増やし、`total` を減らす（税・ net 再計算）。
- **receipt_cash_delta（undo/extra）**: 支払方法別に「精算に戻す／足す」を反映し、payment sections と total を再計算。

**現在の実装**  
- `refundTotal` / `total` / `netSales`: **Shopify の order.refunds と total のみ**で算出。
- `paymentSections`: **order.transactions と order.refunds のみ**で算出（`calculatePaymentSections`）。
- `SpecialRefundEvent` の  
  - `cash_refund`  
  - `receipt_cash_adjustment`（undo / extra）  
  - `payment_method_override`  
  は、**合計や payment sections に一切反映されていない**（表示用の `appliedSpecialRefundEvents` / `appliedVoucherAdjustments` には出ている）。
- 反映しているのは  
  - `voucher_change_adjustment` → `voucherChangeAmount`  
  - ポイント分 → `vipPointsUsed`  
  のみ。

**影響**  
- 現金で行った返金（cash_refund）や、レシート現金調整（receipt_cash_adjustment）を精算レシートの「現金」や合計に載せたい場合、現状では数値が合わない。

**推奨**  
- 精算プレビュー／確定時に、  
  - `cash_refund` → 現金（または actualRefundMethod に紐づく支払方法）の返金に加算し、`refundTotal` を増やし `total` を減らす。  
  - `receipt_cash_adjustment` → `adjustKind`（undo/extra）に応じて、該当支払方法の sale/refund と total を増減。  
  - `payment_method_override` → 返金を「実際に返した方法」のセクションに寄せる。  
- 必要に応じて税・net の再計算（GAS の overlay 後と同様）を行う。

---

### 1.5 receipt_cash_adjustment の「undo / extra」の精算への反映 ✅ 対応済

**GAS の意図**  
- 行フォーマット: `method|kind|amount|note|timestamp`。  
- `kind = undo`: 精算から一度引かれている分を「戻す」（実質返金を取り消して売上に戻す）。  
- `kind = extra`: 精算に「足す」（現金過不足などの調整）。

**現在の実装**  
- `SpecialRefundEvent.adjustKind` に `undo` / `extra` を保存しているが、精算エンジン側で **payment sections や total の増減に使っていない**（1.4 の一部）。

**推奨**  
- 1.4 に含めて、`receipt_cash_adjustment` を payment 別・合計に反映するロジックを実装する。

---

### 1.6 精算注文（Settlement Order）の作成タイミング

**GAS の意図**  
- CloudPRNT 非対応時: 精算レシート印字時に `findOrCreateSettlement` で精算注文（Draft 完成）を用意し、そこにメタや集計結果を紐づける。

**ガイド（8.1）**  
- **order_based** 印字時のみ settlement document / settlement order を生成。  
- **cloudprnt_direct** のときは精算注文を生成しない。

**現在の実装**  
- `api.settlements.create` で Settlement レコードと、order_based の場合は精算注文の作成を行っている（§7.1 で対応済み）。  
- 2026-11 現在: 印字は Printing API を先に試す。精算注文を作らない形への一本化は PR #22。

---

## 2. 意図どおり／設計方針どおりの箇所

- **Gift Card を返金記録に使わない**  
  GAS の `createRefundGiftCardDisabled` は参考のみ。アプリでは **SpecialRefundEvent（cash_refund 等）を正本** としており、ガイド方針と一致している。

- **特殊返金・商品券調整の保存先**  
  GAS の receipt_cash_delta（メタフィールド）→ アプリの **SpecialRefundEvent**（DB）に統一できている。  
  `receipt_cash_adjustment` / `cash_refund` / `payment_method_override` / `voucher_change_adjustment` の 4 種も要件どおり。

- **支払方法の正規化**  
  ハードコードではなく **PaymentMethodMaster** と `getPaymentMethodDisplayLabel` で表示名を解決しており、ガイドの「管理画面設定で吸収」と一致。

- **ロケーション名のハードコード廃止**  
  GAS の `LOCATION_LABELS` に相当する固定表は使わず、Location の `name` / `displayName` と設定で扱えており、ガイド方針どおり。

- **vip_points_used の固定依存をやめている**  
  ポイント利用は **loyalty_usage** 系の設定と `originalPaymentMethod === "points"` で扱っており、特定アプリ固定になっていない。

- **売上サマリーのキャッシュ**  
  GAS の DailyCache / MTDCache / Footfall に相当するデータを、**SalesSummaryCacheDaily・Period、FootfallReport、Budget** などアプリ DB で持つ設計になっており、ガイドの「スプレッドシートを置き換える」と一致。

- **特殊返金の「取引選択前提」**  
  注文検索 → 取引選択 → 特殊返金・商品券調整の UI になっており、ガイドの「対象取引を検索・選択したうえで処理」と一致。

---

## 3. CloudPRNT 対応で追加したい点（GAS にはない）

> 2026-11 現在: CloudPRNT は main で印字用のデータを作るだけ（実機アダプタなし）。印字の主な経路は Shopify Printing API に移り、PR #22 で CloudPRNT は廃止（410）、精算注文も作らない予定。以下は 2026-03 時点の考え方として残す。

- **印字方式の分岐**  
  - **order_based**: 精算レシートは「精算注文」を経由して印字（従来の GAS に近い）。  
  - **cloudprnt_direct**: 精算データを CloudPRNT で直接印字し、精算注文は作らない（ガイド 8.1）。

- **ロケーションごとの印字設定**  
  - 管理画面の印字設定・ロケーション設定（`printMode`, `cloudprnt_enabled`, `printer_profile_id` など）で、店舗ごとに order_based / cloudprnt_direct を切り替えられるようにする。

- **自社用のロケーション名・特殊ルール**  
  - 特定ロケーション名や特殊な集計ルールは、**管理画面の設定（Location 表示名・支払方法マスタ・特殊返金設定など）** で吸収し、コードのハードコードにしない。

---

## 4. 修正時の優先度の目安（1.1〜1.5 は対応済み）

| 優先度 | 項目 | 状態 |
|--------|------|------|
| 高 | 1.1 日次集計のタイムゾーン | ✅ 対応済（shop.ianaTimezone） |
| 高 | 1.2 特殊返金イベントの対象日 | ✅ 対応済 |
| 高 | 1.4 特殊返金を合計・payment sections に反映 | ✅ 対応済 |
| 中 | 1.5 receipt_cash_adjustment の undo/extra | ✅ 対応済 |
| 中 | 1.3 返金の再集計（別パス） | ✅ 対応済 |
| 低 | 1.6 精算注文の作成条件 | ✅ 対応済（§7.1：order_based 時のみ作成） |

---

## 5. 日次集計のタイムゾーン：Shopify ショップ設定から取得する設計

日次集計の「その日」の境界は、**Shopify で設定している国・タイムゾーン** に合わせる形にするのがおすすめです。

### 5.1 利点
- **国・地域に依存しない**: 日本以外のショップでも、管理画面で設定したタイムゾーンの「1日」で集計できる。
- **単一の情報源**: ショップの「ストアの詳細」で設定したタイムゾーンと一致し、運用と整合する。
- **アプリ側のハードコード不要**: JST 固定にせず、`shop.ianaTimezone` に任せられる。

### 5.2 取得方法
- **GraphQL Admin API**: `shop { ianaTimezone }` で IANA タイムゾーン文字列（例: `Asia/Tokyo`, `America/Los_Angeles`）を取得できる。
- 精算・売上サマリー・特殊返金イベントの「対象日」を計算する前に、admin で 1 回クエリすればよい（必要ならキャッシュ可）。

### 5.3 フォールバック
- API で取得できない、または未設定の場合は、**一般設定の `defaultTimezone`**（例: `Asia/Tokyo`）にフォールバックする。
- 既存の「デフォルトタイムゾーン」は、そのまま上書き用・フォールバック用として使える。

### 5.4 実装の流れ（案）
1. **ユーティリティ**: 「日付文字列（YYYY-MM-DD）＋ IANA タイムゾーン」から、その現地日の 00:00:00 と 23:59:59.999 に対応する **UTC の Date または ISO 文字列** を返す関数を用意する（Node の `Intl` や `date-fns-tz` 等で実装可能）。
2. **タイムゾーン取得**: 精算・売上サマリー・特殊返金の日次集計を行う箇所で、`shop { ianaTimezone }` を取得（または AppSetting にキャッシュしておき、未設定時は general_settings の `defaultTimezone` を使用）。
3. **クエリに適用**:  
   - Shopify 注文: 上記 UTC 範囲で `created_at` のクエリを組み立てる。  
   - 特殊返金イベント: 上記 UTC 範囲で `createdAt` をフィルタする。

---

## 6. 参照したドキュメント

- `gas_implementation_guide_template.md`（Cursor 向け GAS 実装ガイド）
- `GAS_精算レシート.md`（精算・集計・返金再集計・receipt_cash_delta）
- `GAS_売上集計.md`（日次・月次キャッシュ、入店数、予算）
- `GAS_返金処理.md`（Gift Card 返金記録）
- `GAS_特殊返金.md`（getReceiptAdjust、appendReceiptCashDeltas、undo/extra）
- `posreceipt_requirements_spec.md`（要件書）
- 現行コード: `app/services/settlementEngine.server.ts`, `app/routes/api.special-refunds.tsx`, `app/services/salesSummaryEngine.server.ts` 等
- Shopify: [Shop (GraphQL)](https://shopify.dev/docs/api/admin-graphql/current/objects/Shop) の `ianaTimezone` フィールド

---

## 7. 残りの相違点・確認事項（§7.1〜7.3 は対応済み）

上記 1.1〜1.5・1.3 および §7 を実装した結果、**GAS とアプリの論点は一通り解消済み**です。

### 7.1 精算注文の作成タイミング（1.6） ✅ 対応済

- **内容**: order_based のときだけ精算 document / 精算注文を生成し、cloudprnt_direct のときは精算注文を生成しない（ガイド 8.1）。
- **対応**: `api.settlements.create` で `printMode === "order_based" && !isInspection` のときのみ `createSettlementOrder` を呼ぶ分岐になっており、cloudprnt_direct では精算注文を作成しない。コメントでガイド 8.1 を明記済み。

### 7.2 税・net の再計算 ✅ 対応済

- **内容**: 返金オーバーレイ・特殊返金反映後に、税・net を再計算する。
- **対応**: 精算エンジンで、返却前に税と netSales を再計算する。2026-11 現在は、支払方法別の（売上 − 返金）の合計を total とし、精算設定の「消費税率（%）」（未設定は 10%）で税込みとして分ける（`splitTaxInclusiveToNetAndTax`）。

### 7.3 売上サマリーの返金反映 ✅ 対応済

- **内容**: 売上サマリーの actual を「その日の返金」を反映した純売上とする。
- **対応（2026-11 現在）**: 売上サマリーの日次は `computeAndCacheDailySummary` が精算プレビュー（`buildSettlementPreview`）を呼び、`actual = preview.netSales`（税抜きの純売上）とする。精算と売上サマリーの数字の差をなくすため。2026-03 版の `getRefundOverlayForDay` によるオーバーレイは今の売上サマリーでは使っていない。

### 7.4 その他（設計の違い）

- **GAS 固有の運用**: スプレッドシート依存、Gift Card 返金記録、Script Properties などは、ガイドどおりアプリでは採用せず、DB・管理画面設定に寄せた設計のまま。
- **税率**: 精算設定の「消費税率（%）」で変えられる（未設定は 10%）。2026-03 版の「10% 固定」は古い。

---

## 8. 精算プレビュー「数字が合わない」原因になりうるロケーション別集計の相違（GAS vs POS）

GAS 精算レシート（`GAS_精算レシート.md`）のロケーション別集計と、pos-receipt の精算プレビュー（`settlementEngine.server.ts`）では、以下の設計差があるため、**同じ日・同じロケーションでも数字が一致しない場合**があります。

> **2026-11-22 更新**: §8.1〜§8.5 と §8.7 の差は、その後の GAS 型の集計（`aggregateGasStyleForOrders`）でほぼ解消した。各節の表の「POS（アプリ）」の列は今の動きに書き直し、2026-03 時点の動きは「旧」として残した。

### 8.0 件数・売上が GAS より多くなる原因（修正済み）✅

**現象**: 実態は 21 件なのにプレビューで 51 件、売上も約 2 倍になる。

| 項目 | GAS（精算レシート） | 修正前の POS（アプリ） | 修正後の POS |
|------|----------------------|-------------------------|----------------|
| **クエリで除外する注文** | `-tag:SETTLEMENT` と `-status:cancelled` を**必ずクエリに含める**（`baseNoCancelled`）。精算注文・キャンセル済みは**取得対象外** | クエリには **含めていなかった**。`location_id` と `created_at` のみ | クエリに **`-tag:SETTLEMENT -status:cancelled` を追加**（GAS と同一） |
| **取得後のタグ除外** | クエリで除外済みのため不要 | `node.tags?.includes("settlement")` で除外。Shopify のタグは **大文字 "SETTLEMENT"** のことが多く、`includes("settlement")` は **false** のため **除外されていなかった** | クエリで除外 ＋ コードでは **大文字小文字を無視**して `settlement` を除外（安全のため二重ガード） |

**原因**  
- 精算実行時に作成される「精算注文」（tag: SETTLEMENT）がクエリで除外されておらず、かつコードの `includes("settlement")` が大文字の "SETTLEMENT" にマッチしなかったため、**精算注文がそのまま集計に含まれていた**。  
- その結果、通常注文 21 件 ＋ 精算注文など 30 件 ≒ 51 件となり、売上も重複・不要分が加算されて約 2 倍に見えていた。

**対応**（`settlementEngine.server.ts`）  
1. **created_at 用クエリ**に `tag_not:settlement -status:cancelled` を追加（Shopify の order 検索では `tag_not` が有効な場合がある。精算注文は `tags: ["settlement"]` で作成しているため小文字で指定）。  
2. **updated_at 用クエリ**（返金オーバーレイ用）にも同様に追加。  
3. 取得後のフィルタを `tags.some(t => String(t).toLowerCase() === "settlement")` に変更し、表記ゆれがあっても精算注文を確実に除外。

**デプロイ後も件数・売上が多い場合の確認ポイント**  
- **ビルドが本番に反映されているか**: 本番は `build/` を実行するため、デプロイ時に **必ずビルドが走ること**が必要。Render の場合は「Clear build cache & deploy」で再デプロイすると、古いキャッシュでビルドがスキップされていた問題を解消できる場合がある。  
- **クエリが効いていない可能性**: Shopify の order 検索で `tag_not:settlement` や `-tag:settlement` が無視される場合がある。その場合は「取得後のコード側フィルタ」（上記 3）で精算注文は除外されるが、**件数・金額は「取得した注文」を元にしている**ため、クエリで除外されないと API のページングで多くの件数を取得し、その分だけ件数・売上が多くなる。  
- **ロケーション・日付**: 渡している `locationId` が正しいか、`targetDate` が想定している日付（ショップタイムゾーンの「その日」）と一致しているかも確認する。

---

### 8.1 注文の対象範囲

| 項目 | GAS | POS（アプリ） |
|------|-----|----------------|
| 集計に使う注文 | **created_at がその日** の注文 ＋ **updated_at がその日** の注文（`fetchAllOrdersSmart` でユニオン）＋ 当日 **updated** のキャンセル済み | **2026-03 対応**: `created` 検索結果を **createdAt で暦日厳密フィルタ**したもの ＋ **updated_at がその日（非キャンセル）** ＋ **当日 updated のキャンセル済み** を **id ユニオン**（`settlementEngine` の `unionSettlementOrdersById`）。返金オーバーレイは二重計上防止のため **オフ**（返金はメインループで計上） |
| 補足 | 「その日に更新された注文」も集計対象 | 旧実装は created のみ＋返金オーバーレイで売上が欠けるケースがあった |

**影響（旧実装時）**  
- 前日作成・当日キャプチャ（または当日更新で売上追加）した注文は、GAS ではその日の売上に含まれるが、**created のみ**のアプリでは **total に含まれない** ため、**売上・件数が少なく出る**可能性がありました。

**GAS ④（processed_at フォールバック）: 対応済み（2026-11 確認）**  
- ユニオンが 0 件のときだけ、店舗タイムゾーンの暦日で `processed_at` を使って取り直す（`buildSettlementPreview`）。2026-03 版の「未実装」は古い。

### 8.2 total（総売上）の算出根拠

| 項目 | GAS | POS（アプリ） |
|------|-----|----------------|
| total の元データ | **「その日」に発生したトランザクション**のみ。各 Tx の `createdAt` がその日（JST）か、REFUND は「その日の Refund に紐づく」かで判定。total = 支払方法別 (sale − refund) の合計 | **今（2026-11）: GAS と同じ**。その日（店舗タイムゾーン）の Tx か、その日の Refund に紐づく REFUND の Tx だけを支払方法別に集め、特殊返金を反映したあと、支払方法別の (net − refund) の合計を total にする。旧（2026-03）: その日に created の注文の `totalPriceSet` の合計 |
| 日付の意味 | **取引発生日（トランザクション日）** ベース | **今: 取引発生日ベース**（旧: 注文作成日ベース） |

**影響**  
- 旧実装では日付をまたぐ取引（例: 23:55 作成・00:05 キャプチャ）で total がずれた。今は GAS と同じ考え方。
- 行合計との整合: 今は total を支払方法別の行の合計から出すので、行と合計は一致する（GAS のガードと同じ結果）。

### 8.3 返金の「その日」の扱い

| 項目 | GAS | POS（アプリ） |
|------|-----|----------------|
| 返金を「その日」に含める条件 | **refund.createdAt** がその日（JST）の返金のみ「その日の返金」として集計（aggregate 内＋ computeRefundsOnlyForDay） | **今（2026-11）: GAS と同じ**。その日（店舗タイムゾーン）に作られた Refund とその Tx だけを数える。返金オーバーレイは使わない（ユニオンのメインループで数えるので二重にしない）。どの店舗に載せるかは返金の計上ロケーション（メタフィールド・設定、`refundAggregation.server.ts`）で決める。旧（2026-03）: その日に created の注文の全 refund ＋ オーバーレイ |
| 返金の日付帰属 | **返金が処理された日** | **今: 返金が処理された日**（旧: 注文作成日） |

**影響**  
- 旧実装では、翌日返金がその日（注文作成日）の精算に入った。今は GAS と同じく返金した日の精算に入る。

### 8.4 refund_count（返金件数）の定義

| 項目 | GAS | POS（アプリ） |
|------|-----|----------------|
| refund_count | **返金が 1 件以上ある注文の数**（refundOrderSet.size） | **今（2026-11）: GAS と同じ**（`refundOrderSet.size`）。支払方法別の行の返金件数は Tx の件数。旧（2026-03）: Refund オブジェクトの件数 |

**影響**  
- 旧実装では 1 注文で複数回返金すると件数がずれた。今は GAS と同じ。

### 8.5 割引・ポイント（discounts / vip）の按分

| 項目 | GAS | POS（アプリ） |
|------|-----|----------------|
| 割引・VIP | aggregate 内で **その日の売上・返金の比率（keepRatioToday）** を按分して discounts / vip_points_used を集計 | **今（2026-11）: GAS と同じ按分**（`keepRatioToday`）。ポイント利用額は明細の割引のうち「ポイント/会員施策設定」の決まり（VIP-・SP-POINT-・Shop Point など）に合うものを按分して数える。Shopify の税（`taxShopify`）も同じ比率で按分する。旧（2026-03）: 注文の `totalDiscountsSet` をそのまま合計・按分なし |

**影響**  
- 旧実装では一部返金・部分キャンセルで内訳がずれた。今は GAS と同じ考え方。

---

### 8.6 まとめ：数字が合わないときに確認するポイント

> 以下 1〜5 は 2026-03 の旧実装のときの確認ポイント。今の main では §8.1〜§8.5 の差はほぼ無いので、合わないときはまず、ロケーション・日付（店舗タイムゾーン）・返金の計上ロケーションの設定・特殊返金の反映設定・「旧ギフトカード API 集計」の ON/OFF を確かめる。業務ルールは `docs/BUSINESS_RULES.md`。

1. **total が GAS より少ない**  
   → 前日作成・当日キャプチャ（または当日更新）の注文が POS では「その日の売上」に含まれていない可能性（§8.1・8.2）。

2. **total が GAS と違う（日付をまたぐ取引がある日）**  
   → トランザクション日ベース（GAS）と注文作成日ベース（POS）の差（§8.2）。

3. **返金の日付がずれる**  
   → 「その日に作成した注文の翌日返金」が、GAS では翌日、POS ではその日の refundTotal に入る差（§8.3）。

4. **返金件数が違う**  
   → 注文数ベース（GAS）と Refund 件数ベース（POS）の差（§8.4）。

5. **割引・ポイントの内訳が違う**  
   → 按分の有無（§8.5）。

GAS に合わせる場合は、注文対象の「updated_at ユニオン」、total の「トランザクション日ベース」化、返金の「refund.createdAt でその日のみ」化、refund_count の「注文数」化、割引・ポイントの按分などを、要件に応じて pos-receipt 側に追加・変更する必要があります。

---

### 8.7 GAS との集計方法の相違一覧（どこで何が違うか）

| # | 項目 | GAS の集計方法 | POS（アプリ）の集計方法 | 主な影響 |
|---|------|----------------|-------------------------|----------|
| 1 | **集計対象注文の絞り方** | クエリで **`-tag:SETTLEMENT -status:cancelled`** を必ず指定。精算注文・キャンセルは取得しない | 修正後: 同上。修正前は指定がなく、かつタグ判定が大文字で効かず精算注文が混入 | 修正前: 件数・売上が約2倍になる（§8.0） |
| 2 | **注文の範囲** | **created_at がその日** ∪ **updated_at がその日** のユニオン。2本のクエリをマージ | 今: created ∪ updated ∪ 当日 updated のキャンセル済みのユニオン。0 件のときは processed_at で取り直す（旧: created のみ） | 今は差なし（§8.1） |
| 3 | **total の根拠** | **その日に発生したトランザクション**だけ。Tx の createdAt（またはその日の Refund 紐づき）で判定。total = 支払方法別 (sale − refund) の合計 | 今: GAS と同じ（旧: その日に created の注文の totalPriceSet 合計） | 今は差なし（§8.2） |
| 4 | **返金の「その日」** | **refund.createdAt がその日**の返金のみ「その日の返金」として計上 | 今: GAS と同じ。載せる店舗は返金の計上ロケーションで決める（旧: その日 created の注文の全 refund） | 今は差なし（§8.3） |
| 5 | **refund_count** | 返金が 1 件以上ある**注文の数** | 今: GAS と同じ（旧: Refund オブジェクトの件数） | 今は差なし（§8.4） |
| 6 | **割引・ポイント** | その日の売上・返金の**按分**で discounts / vip を集計 | 今: GAS と同じ按分（旧: 按分なし） | 今は差なし（§8.5） |
| 7 | **整合性ガード** | 行合計（payment sections の net）と header の total が一致するよう補正 | 今: total を行の合計から出すので一致する（旧: なし） | 今は差なし |

以上が、GAS 実装と比較したうえでの「意図とずれている箇所」「対応内容」「残りの相違点」および**精算プレビュー数字の相違原因**の整理です。
