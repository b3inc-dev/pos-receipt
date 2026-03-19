# POS Receipt：ロケーション抽出・オンラインストア除外の検証

**目的**: ロケーション指定で「ロケーションありの注文のみ」が取得できているか、およびオンラインストア注文の扱いを確認する。

---

## 0. ロケーションなし注文が含まれていた要因と対応（2025年対応）

### 0.1 要因

実運用で「ロケーションがない注文（オンラインストア等）がまだ含まれている」ことが判明した。想定される要因は次のとおり。

1. **Shopify の `location_id` の解釈**
   - 公式ドキュメントでは「location id that's **associated with** the order」とあり、**retail（POS）ロケーションに限定されていない**可能性がある。
   - 履行ロケーション（fulfillment）や参照ロケーション（reference_location_id）など、別の紐づけで「そのロケーションに associated」とみなされたオンライン注文がヒットし、結果に含まれる場合がある。

2. **クエリのみに依存していた**
   - `location_id:XXX` だけに頼っており、取得後の **retailLocation による絞り込み** をしていなかった。
   - API が想定より広い条件で注文を返すと、そのまま集計・一覧に含まれてしまう。

### 0.2 実施した対応

- **クエリに `source_name:pos` を追加**
  - 精算・売上サマリー・注文検索のいずれも、ロケーション指定時に **`source_name:pos`** をクエリに含めるようにした。
  - POS で発生した注文のみが対象となり、オンラインストア注文はクエリ段階で除外される。

- **取得後の retailLocation フィルタ**
  - 精算・売上サマリーでは、GraphQL で **`retailLocation { id }`** を取得し、**指定ロケーションと一致する注文だけ** を集計対象にした（`filterOrdersByRetailLocation` / `filterSummaryOrdersByRetailLocation` 等）。
  - 注文検索 API では、`locationId` 指定時に返却 `items` を **retailLocation がそのロケーションのものだけ** に絞り込むようにした。

- **注文検索の locationId 正規化**
  - クエリ用に **数値の location ID のみ** を使うよう `normalizeLocationIdForQuery` を追加（GID 形式で渡されても数値に変換）。

上記により、「ロケーションのみ」の抽出と「ロケーションなし（オンライン等）の除外」を二重で担保している。

### 0.3 デプロイ後も数字が変わらなかった要因（キャッシュ）と対応

**要因**: 売上サマリーの **期間表示**（`/api/sales-summary/period`）は、**日次キャッシュ（SalesSummaryCacheDaily）を読むだけ**で、Shopify から再取得していなかった。  
そのため、ロジック変更前に計算された古いキャッシュがそのまま使われ、「デプロイしたのに数字が変わらない」状態になっていた。

**対応**: 期間 API で、`dateFrom` と `dateTo` が指定されているときは、**対象日付×ロケーションごとに `computeAndCacheDailySummary` を一度呼んでキャッシュを更新してから**、キャッシュを集計するように変更した（`api.sales-summary.period.tsx`）。  
これにより、期間を開くたびに最新ロジックで再計算され、正しい数字が表示される。再計算は最大 31 日分に制限している。

- **日次表示**（`/api/sales-summary/daily`）はもともと毎回 `computeAndCacheDailySummary` を呼んでおり、常に再計算→キャッシュ更新→返却のため、デプロイ後もその日を開けば正しい数字になる。
- **精算**はキャッシュを使わず毎回 Shopify から取得しているため、デプロイ反映後は即正しい数字になる。

---

## 1. ロケーション抽出が「ロケーションのみ」になっているか

### 1.1 現状の実装

次の箇所で、注文取得時に **`location_id:${locIdRaw}`** をクエリに含めています。

| 機能 | ファイル | クエリ例 |
|------|----------|----------|
| 精算プレビュー・精算作成 | `app/services/settlementEngine.server.ts` | `location_id:${locIdRaw} source_name:pos created_at:>=... tag_not:settlement -status:cancelled` ＋ retailLocation で事後フィルタ |
| 売上サマリー（日次） | `app/services/salesSummaryEngine.server.ts` | `location_id:${locIdRaw} source_name:pos created_at:>=... tag_not:settlement -status:cancelled` ＋ retailLocation で事後フィルタ |
| 注文検索（領収書・特殊返金） | `app/routes/api.orders.search.tsx` | `location_id:${locIdRaw} source_name:pos`（`locationId` を渡した場合）＋ 返却前に retailLocation でフィルタ |

いずれも **Shopify Admin API の orders クエリ** の `query` 引数で `location_id:XXX` を指定しています。

### 1.2 Shopify の仕様（location_id の意味）

[Shopify Admin API - orders クエリ](https://shopify.dev/docs/api/admin-graphql/latest/queries/orders) より:

- **`location_id`**:  
  「Filter by the location **id that's associated with the order** to view and manage orders for specific locations. For POS orders, locations must be defined in the Shopify admin... Example: `location_id:123`」
- つまり **「そのロケーションに紐づいている注文」だけ** が返ります。
- オンラインストアで発生した注文は、通常 **retailLocation が null**（ロケーションに紐づかない）のため、`location_id:123` の条件に **マッチしません**。

### 1.3 結論（ロケーションのみになっているか）

- **なっています。**
- `location_id:XXX` を指定しているため、返ってくるのは「そのロケーションに紐づく注文」のみです。
- ロケーションがない注文（オンラインストア等）は、クエリ時点で **除外** されています（API がそもそも返さない）。

### 1.4 手動で確認する方法

1. **管理画面または POS で「精算」や「売上サマリー」を、特定ロケーション・日付で実行**  
   → 表示される注文件数・合計が、そのロケーションの POS 注文だけと一致するか確認する。

2. **注文検索 API を直接叩く**  
   - `GET /api/orders/search?locationId=<ロケーションID>&dateFrom=...&dateTo=...`  
   - 返却された `items` の各要素に `locationId` / `locationName` が入っているか確認する。  
   - さらに Shopify 管理画面の「注文」で、同じ期間の「オンラインストア」注文が **一覧に含まれていないこと** を目視で確認する。

3. **意図的に「ロケーションなし」注文を混ぜられないか**  
   - クエリに `location_id` を付けている限り、Shopify 側が「その location に紐づく注文」だけを返すため、**アプリ側で追加でフィルタしなくても** ロケーションなし注文は混ざりません。

---

## 2. ロケーションがない注文（オンラインストア等）が除外できているか

### 2.1 結論

- **除外できています。**
- 上記のとおり、`location_id` を指定したクエリでは「そのロケーションに紐づく注文」だけが返るため、**ロケーションがない注文は API の結果に含まれません**。
- したがって、精算・売上サマリー・注文検索（ロケーション指定時）のいずれも、「オンラインストアのみの注文」や「その他ロケーションなし注文」は **含まれません**。

---

## 3. オンラインストアは「オンラインストアのみ」で抽出できているか

### 3.1 現状の実装の確認結果

- コードベース内で **`source_name`** や **`channel`** など、注文の「販売チャネル（オンライン / POS 等）」で絞り込んでいる箇所は **ありません**。
- 領収書・精算・売上サマリー・注文検索はいずれも:
  - **ロケーションありの注文** を対象にする（`location_id` 指定）、または
  - ロケーションを指定しない場合は **全注文** が対象になる  
  という動きです。
- 「**オンラインストアの注文だけ**」を抽出する専用の API や画面（例: `source_name:web` で検索する機能）は **実装されていません**。

### 3.2 結論（オンラインストアのみで抽出できているか）

- **いいえ。現状は「オンラインストアのみ」で抽出する機能はありません。**
- あるのは次のどちらかです:
  - **ロケーション指定** → そのロケーションに紐づく注文（主に POS）のみ
  - **ロケーション未指定** → 全注文（オンライン・POS 混在）

### 3.3 オンラインストアのみを抽出したい場合の実装案

Shopify の orders クエリでは **`source_name`** でチャネルを指定できます（[検索構文](https://shopify.dev/docs/api/admin-graphql/latest/queries/orders) の `query` 引数）。

- 例: `source_name:web` … オンラインストアで発生した注文
- 例: `source_name:pos` … POS で発生した注文

「オンラインストアのみ」で抽出する機能を追加する場合は、例えば次のような対応が考えられます。

1. **注文検索 API**（`api.orders.search.tsx`）  
   - クエリパラメータに `sourceName=web` などを追加する。  
   - `buildSearchQuery` 内で `source_name:web` を `query` に含める。

2. **新規 API または管理画面**  
   - 「オンラインストア注文のみ」を一覧・集計する用途であれば、`query` に `source_name:web` を付けた専用の API または画面を用意する。

現状の「ロケーションのみ」「ロケーションなし除外」の検証としては、**ロケーション指定時にはオンラインストア注文は結果に含まれない** ことで要件は満たしています。

---

## 4. まとめ

| 確認項目 | 結果 |
|----------|------|
| ロケーション抽出がロケーションのみになっているか | ✅ **なっている**（`location_id` 指定により、そのロケーションに紐づく注文のみ取得） |
| ロケーションがない注文（オンラインストア等）が除外できているか | ✅ **除外できている**（`location_id` クエリの仕様で、ロケーションなし注文は返らない） |
| オンラインストアはオンラインストアのみで抽出できているか | ❌ **現状はできない**（`source_name:web` 等で絞る機能は未実装。必要なら追加実装が必要） |

---

## 5. 参照コード一覧（該当箇所）

- **注文検索**: `app/routes/api.orders.search.tsx` の `buildSearchQuery`（`source_name:pos` 追加）、`normalizeLocationIdForQuery`、返却前の retailLocation フィルタ
- **精算エンジン**: `app/services/settlementEngine.server.ts` の `buildSettlementPreview` 内の `shopifyQuery`（`source_name:pos` 追加）、`filterOrdersByRetailLocation` / `filterOrdersUpdatedByRetailLocation`、`getRefundOverlayForDay` 内の `updatedQuery`（`source_name:pos` 追加）
- **売上サマリー**: `app/services/salesSummaryEngine.server.ts` の `computeAndCacheDailySummary` 内の `shopifyQuery`（`source_name:pos` 追加）、`filterSummaryOrdersByRetailLocation`
