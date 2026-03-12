# GAS 実装と pos-receipt アプリ実装の比較・ギャップ一覧

要件書を正本とし、GAS は CloudPRNT 非対応のみの参考実装として、今回のアプリで **CloudPRNT 対応を追加** する前提で比較しました。  
ロケーション名や自社用の調整は、管理画面から各社ごとに設定できる想定です。

**実装済み（2026-03 対応）**  
- 1.1・1.2: 日次集計のタイムゾーンを Shopify の `shop.ianaTimezone`（フォールバック: 一般設定の defaultTimezone）で算出し、精算・売上サマリー・特殊返金イベントの対象日に適用。  
- 1.3: 返金の再集計（別パス）を実装。その日に `updated_at` で更新された注文を取得し、`refund.createdAt` がその日かつ「その日作成」でない注文の返金のみをオーバーレイして payment sections と refundTotal / refundCount にマージ。  
- 1.4・1.5: 特殊返金イベント（cash_refund / receipt_cash_adjustment undo・extra / payment_method_override）を精算の total・refundTotal・paymentSections に反映。  
- **§7.1**: 精算注文は `order_based` のときのみ作成し、`cloudprnt_direct` のときは作成しない（api.settlements.create で分岐済み。コメントでガイド 8.1 を明記）。  
- **§7.2**: 返金・特殊返金反映後に税・net を再計算（effectiveGross = total - refundTotal - discounts、税 10% 込で tax / netSales を算出）。  
- **§7.3**: 売上サマリーの actual を純売上（粗利 − その日の返金）に変更。注文の refunds 集計と `getRefundOverlayForDay` でオーバーレイを加味。

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
- `api.settlements.create` で Settlement レコードと、order_based の場合は精算注文の作成を行っている。  
- 印字方式（order_based / cloudprnt_direct）に応じて「精算注文を作る／作らない」の分岐は、実装と要件の対応を確認するとよい（現状は order_based 前提で問題なさそう）。

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
- **対応**: 精算エンジンで、`effectiveGross = total - refundTotal - discounts` から税（10% 込）と netSales を算出し、返却前に再計算するようにした。

### 7.3 売上サマリーの返金反映 ✅ 対応済

- **内容**: 売上サマリーの actual を「その日の返金」を反映した純売上とする。
- **対応**: 日次注文クエリに `refunds` を追加し、その日の注文の返金合計に加え、`getRefundOverlayForDay` で「その日作成でない注文のその日付の返金」を加味。`actual = gross - refundsFromOrders - overlay.refundTotal` で純売上を算出。

### 7.4 その他（設計の違い）

- **GAS 固有の運用**: スプレッドシート依存、Gift Card 返金記録、Script Properties などは、ガイドどおりアプリでは採用せず、DB・管理画面設定に寄せた設計のまま。
- **税率**: 精算の税再計算では 10%（10/110）を固定で使用。他税率・設定化は要件に応じて追加可能。

以上が、GAS 実装と比較したうえでの「意図とずれている箇所」「対応内容」「残りの相違点」の整理です。
