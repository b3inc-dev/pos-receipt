# POS Receipt：ログイン中ロケーションのスコープ

## 結論（調査時点）

**現状、全てのアプリタイルで「ログインしているロケーションの情報だけ」にはなっていません。**  
他ロケーションのデータが表示・操作対象に含まれる可能性があります。

## 仕組み：POS の「現在のロケーション」

Shopify POS UI Extensions の **Session API** で、現在のセッション情報を取得できます。

- `shopify.session.currentSession.locationId` … この POS に**現在ログインしているロケーションの ID**（数値）
- ホームのタイルやモーダルは、この `locationId` を使って「今の店舗」だけに絞る必要があります

参照: [Session API](https://shopify.dev/docs/api/pos-ui-extensions/2024-04/apis/session-api)

## 現状の挙動（ロケーション未限定）

| 機能 | 挙動 | 他ロケーション混入の有無 |
|------|------|---------------------------|
| **売上サマリー** | `locationIds` を渡していない → バックエンドが「売上サマリー有効な全ロケーション」を返す | ✅ 混入する |
| **精算** | 全ロケーションを取得し、ユーザーがドロップダウンで選択（初期値は先頭） | ✅ 他ロケーションを選択可能 |
| **領収書（取引検索）** | `searchOrders` に `locationId` を渡していない | ✅ 全ロケーションの注文が検索される |
| **特殊返金・商品券** | 同上、`searchOrders` に `locationId` なし | ✅ 全ロケーションの注文が検索される |
| **特殊返金・登録時** | 選択した注文の `order.location.id` を使用 | ❌ 注文に紐づくロケーションのみ（問題なし） |
| **領収書発行** | 選択した注文の `retailLocation` を使用 | ❌ 同上（問題なし） |

## 修正方針

1. **共通**  
   `shopify.session.currentSession.locationId` を取得するヘルパーを用意し、必要に応じて GID 形式（`gid://shopify/Location/{id}`）に変換して API に渡す。

2. **売上サマリー**  
   `getDailySummary` / `getPeriodSummary` 呼び出し時に、現在ロケーションの ID（または GID）だけを `locationIds` に渡し、**表示はログイン中ロケーションのみ**にする。

3. **精算**  
   - ロケーション一覧の取得は現状のまま（またはバックエンドで「このショップのロケーション」を返す）  
   - **初期選択**を `currentSession.locationId` に一致するロケーションにする。  
   - （方針による）ドロップダウンを「現在ロケーションのみ」に制限するか、選択は自由だが初期値だけ現在ロケーションにする。

4. **注文検索（領収書・特殊返金）**  
   `searchOrders` 呼び出し時に、セッションの `locationId` を渡し、**ログイン中ロケーションの注文だけ**を検索する。

5. **バックエンド**  
   - 注文検索は既に `location_id` クエリで絞り込み可能。  
   - 売上サマリー系 API は既に `locationIds[]` で絞り込み可能。  
   → フロント（拡張）で「現在ロケーション」を渡すだけで、ログイン中ロケーションのみに限定できる。

## 実装後の期待動作（対応済み）

- **売上サマリー** … `getSessionLocation()` で取得したロケーション ID を `locationIds` に渡し、**ログイン中ロケーションの KPI のみ**表示。
- **精算** … ロケーション一覧を**現在セッションのロケーションのみ**にフィルタし、選択肢もその1件のみ。他店舗を選べない。
- **領収書・特殊返金の取引検索** … `searchOrders` 呼び出し時にセッションの `locationIdParam` を渡し、**ログイン中ロケーションの注文のみ**一覧に表示。

これにより、「POS でログインしているロケーションの情報だけを扱う」状態に揃えています。

### 実装ファイル

- `extensions/common/sessionLocation.js` … セッションの現在ロケーション取得ヘルパー（`getSessionLocation()`）
- `extensions/pos-smart-grid/src/SalesSummaryModal.jsx` … 日次・期間サマリーで `locationIds` をセッションロケーションに限定
- `extensions/pos-smart-grid/src/SettlementModal.jsx` … ロケーション一覧をセッションロケーションのみにフィルタ
- `extensions/pos-smart-grid/src/ReceiptModal.jsx` … 取引検索に `locationId` を渡す
- `extensions/pos-smart-grid/src/SpecialRefundModal.jsx` … 同上
