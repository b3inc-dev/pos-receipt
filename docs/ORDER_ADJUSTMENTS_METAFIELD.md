# 注文メタフィールド `pos.adjustments`（特殊返金・商品券調整）

特殊返金（③）と商品券調整（④）の記録は、注文 1 件につき 1 つの JSON メタフィールドに残します。pos-receipt の精算と ciara-system は、同じ値を同じ決まりで数えます。ギフトカードは使いません（T の決定 2026-11-23）。

- 書くのは pos-receipt だけです。直すときは、アプリの「変更」（POS・管理画面・注文ページ）から直します。Shopify の画面で JSON を書き換えないでください。
- pos-receipt の DB（`SpecialRefundEvent`）には、同じ中身を履歴と「日・店 → 注文」の目次として持ちます。
- 行は消しません。直すときは前の行を `voided` にして、`replaces` 付きの行を足します。

コード: `app/services/orderAdjustmentsPure.server.ts`（形と数え方）・`app/services/orderAdjustments.server.ts`（書く・読む）・`app/services/orderAdjustmentEdit.server.ts`（変更・無効化）。

## 1. メタフィールド

| namespace.key | 型 | 中身 |
|---|---|---|
| `pos.adjustments` | `json` | 記録の本体（下の形） |
| `pos.adjustments_summary` | `single_line_text_field` | 人が読むための 1 行（表示用。数えるときは使わない）。例: `11/23 返金手段の付け替え クレジット→現金 ¥1,200 ／ 11/23 商品券 額面¥5,000 お釣り¥800`。行が無いときは「なし」 |

- 名前空間は `pos`（アプリ専用の `$app` ではない）。ほかのアプリ（ciara-system）からも読めるようにするため。`pos.refund_aggregation_location_gid` と同じ場所です。
- 名前付きの定義（「POS 特殊返金・商品券調整」）は、インストールのとき（`auth.$`）か `POST /api/admin/settlement-metafields/ensure` で作ります。定義が無くても値は書けます。
- 古い定義 `pos.special_refund_events`・`pos.voucher_change_events`・`pos.business_adjustments_version` は値を書いていません（使いません）。

## 2. 値の形（version 1）

```json
{
  "version": 1,
  "updatedAt": "2026-11-23T06:10:00.000Z",
  "entries": [
    {
      "id": "pos_sr_…",
      "type": "special_refund",
      "kind": "payment_method_override",
      "adjustKind": null,
      "date": "2026-11-23",
      "locationGid": "gid://shopify/Location/123",
      "fromMethod": "shopify_payments",
      "toMethod": "cash",
      "fromLabel": "クレジット",
      "toLabel": "現金",
      "amount": 1200,
      "currency": "JPY",
      "voucher": null,
      "shopifyRefund": { "status": "skipped", "id": null },
      "status": "active",
      "replaces": null,
      "replacedBy": null,
      "by": "山田",
      "at": "2026-11-23T06:04:00.000Z",
      "voidedAt": null,
      "reason": null
    },
    {
      "id": "cmf…",
      "type": "voucher",
      "kind": "voucher_change_adjustment",
      "adjustKind": null,
      "date": "2026-11-23",
      "locationGid": "gid://shopify/Location/123",
      "fromMethod": null, "toMethod": null, "fromLabel": null, "toLabel": null,
      "amount": 800,
      "currency": "JPY",
      "voucher": { "face": 5000, "applied": 4200, "change": 800 },
      "shopifyRefund": { "status": "skipped", "id": null },
      "status": "active",
      "replaces": null, "replacedBy": null,
      "by": "山田", "at": "2026-11-23T06:10:00.000Z", "voidedAt": null, "reason": null
    }
  ]
}
```

| 項目 | 意味 |
|---|---|
| `id` | 行の番号（DB の `SpecialRefundEvent.id`。変わらない） |
| `type` | `special_refund`（③）か `voucher`（④） |
| `kind` | `cash_refund`（現金返金）・`payment_method_override`（返金手段の付け替え）・`receipt_cash_adjustment`（レシートの現金調整）・`voucher_change_adjustment`（商品券） |
| `adjustKind` | `receipt_cash_adjustment` のときだけ。`undo`（取り消し）か `extra`（追加） |
| `date` | 数える日。店のタイムゾーン（Ciara は日本時間）の `YYYY-MM-DD`。注文の日と違ってよい（先月の注文を今日返したときなど） |
| `locationGid` | 数える店。`gid://shopify/Location/<数字>` |
| `fromMethod` / `toMethod` | 元の支払方法と、実際に返した手段。支払方法マスタに登録した gateway の名前（`rawGatewayPattern`。Shopify の取引の `gateway` と同じ文字。例: `cash`・`shopify_payments`・施設のポイントの名前）。商品券は `null` |
| `fromLabel` / `toLabel` | 支払方法マスタの表示名。読みやすさのため（数えるときは使わない。マスタに無いときは `null`） |
| `amount` | 金額（店の通貨。円は整数だが `.00` の小数が付くことがあるので丸めて読む）。正の数。商品券はお釣りの額 |
| `voucher` | 商品券のときだけ。`face` 額面・`applied` 商品券で払った額（注文の取引から）・`change` お釣り（= 額面 − 使った額、0 未満は 0） |
| `shopifyRefund.status` | `none`・`skipped`（Shopify では返金していない）・`pending`（成否が分からない）・`success`（Shopify で返金済み）・`failed`（Shopify の返金が失敗） |
| `shopifyRefund.id` | Shopify の返金の GID（`success` のとき） |
| `status` | `active`（有効）・`voided`（無効）・`pending_approval`（承認待ち）・`rejected`（却下） |
| `replaces` / `replacedBy` | 「変更」で置き換えた前の行・置き換えた後の行の `id` |
| `by` / `at` | 登録した人（POS のスタッフ名など・無ければ `null`）と時刻（ISO・UTC） |
| `voidedAt` / `reason` | 無効にした時刻と、直したわけ・無効にしたわけ |

- 素の配列（`entries` だけ）も読めるようにしてあります（pos-receipt の読み手）。
- 値は毎回、DB の行から作り直してまるごと書きます。行の順は登録した順です。

## 3. 数え方（pos-receipt と ciara-system で同じ）

その店（`locationGid`）・その日（`date`）の、`status` が `active` の行だけを数えます。`voided`・`pending_approval`・`rejected` は数えません。「変更」で置き換えた前の行は、同じ書き込みで必ず `voided` になります。

| 行 | Shopify の返金 | 精算でどうするか |
|---|---|---|
| `cash_refund`・`payment_method_override` | `success` | Shopify の返金はもう `fromMethod` の行に入っているので、`amount` を `fromMethod` の返金から `toMethod` の返金へ移すだけ。返金の総額は変えない（`fromMethod` の行がその日に無ければ移さず警告） |
| 同上 | `none`・`skipped`・`failed` | `toMethod` の行の返金と、返金の総額に `amount` を足す |
| `receipt_cash_adjustment` | `success` | 何もしない（Shopify の取引に入っている） |
| 同上 `undo` | それ以外 | 返金の総額と `fromMethod` の行の返金から `amount` を引く |
| 同上 `extra` | それ以外 | 売上の総額と `fromMethod` の行の売上に `amount` を足す |
| どれでも | `pending` | 数えない。pos-receipt は精算を確定しない（先に「Shopify 返金を確かめる」） |
| `voucher_change_adjustment` | — | `voucher.change` を「商品券釣有り差額」に足す |

- 商品券: その注文に有効な商品券の行があれば、その注文は自動の判定（支払方法名と注文メモの「商品券N」）をやめて、手で入れた `change` を使う（同じ注文で 2 回足さない）。行が無い注文と昔の注文は、今までどおり自動の判定で数える。※ pos-receipt 側でこの「手が自動を上書き」を効かせるのは PR #92 の数え方（`voucherChangePure.server.ts`）。
- 種別ごとの「精算に反映する」設定（特殊返金設定）がオフの種別は、pos-receipt は数えない。ciara-system に合わせるときはオンのままにする。

## 4. pos-receipt の読み方

1. DB の目次で、その日・その店の行がある注文を出す（`countDate` がその日の行。前からの行で `countDate` が無いものは登録した日）。
2. その注文の `pos.adjustments` を Shopify から読む（`nodes(ids:)` で 50 件ずつ。行が無い日は読まない）。
3. 読めた注文は、メタフィールドの行で数える。DB の行と違えば警告（`metafield_differs`）。Shopify の画面で書き換えられた可能性がある。
4. 値が無い（まだ書けていない）・形が読めない注文は、DB の行で数えて警告（`metafield_missing`・`metafield_invalid`）。読み取りそのものが失敗したときも DB の行で数えて警告。
5. 警告は精算のプレビューの `adjustmentSourceWarnings` に出る。精算は止めない。

## 5. 書くとき

次のあとに、その注文の値を DB から作り直して書きます。書けなくても登録は取り消さず、行の `metafieldSyncError` に残します（次に書いたときに直る）。

- 特殊返金の登録（`POST /api/special-refunds`。Shopify 返金が `pending` のままのときも書く）
- 商品券の登録（`POST /api/voucher-adjustments`）
- 「変更」（`POST /api/special-refunds/:id/edit`）・無効化（`POST /api/special-refunds/:id/void`）
- 「Shopify 返金を確かめる」（`POST /api/special-refunds/:id/recheck`）
- 管理者の承認・却下（`decideSpecialRefundApproval`）

要確認: 注文メタフィールドを書くと、注文の `updated_at` が進むか・`orders/updated` の Webhook が出るか（ciara-system が更新された注文として拾えるか）。開発ストアで確かめる。

## 6. 「変更」

- 前の行を `voided`（`voidedAt`・`reason` 付き）にして、`replaces` 付きの新しい行を足す。1 回の DB のトランザクションで行う。二人が同時に押すと、後の人は断る。
- 直したわけ（`reason`）は必須。
- 数える日は、元の日のままが初めの値。「今日にする」も選べる。確定済みの日を直したら、POS の精算の「更新」で「今の数で再確定する」（D21）。
- Shopify の返金はしない。Shopify で返金済み（`success`）の行を直したときは、返金の記録（`status`・`id`）を新しい行に引き継ぐ（精算は付け替えだけにして二重に数えない）。金額を変えたときは、Shopify の返金は変わらないことを警告する。
- 返金の結果が分からない（`pending`）行は直せない。先に「Shopify 返金を確かめる」。
- 承認待ちの行を直すと、新しい行も承認待ち。
- 返金手段は、支払方法マスタ（有効・特殊返金で選べる）にあるものだけ（#81 と同じ）。

## 7. 商品券は額面だけ

`POST /api/voucher-adjustments` は額面（`voucherFaceValue`）だけでよい。使った額は注文の取引から出す（決まった分け方で「商品券」の種類になる支払方法の、成功した売上から返金を引いた額）。お釣りはサーバーで出す（額面 − 使った額）。取引が読めないときは 400（`VOUCHER_APPLIED_UNKNOWN`）で、POS で使った額を手で入れる。`GET /api/voucher-adjustments?sourceOrderId=…` は、その注文の使った額を返す（POS の画面に先に出すため）。

## 8. 画面

- POS: 「返金・商品券」タイルは返金・キャンセルのある注文、「商品券」タイルは商品券釣有りの注文を、ログイン中の店・その日で初めに出す（検索も使える）。登録の行の「変更」で直す。
- 管理画面: `/app/order-adjustments?orderId=…`（特殊返金履歴の行の「この注文の記録・変更」から開く）。その注文の行を出し、「変更」「無効化」と、注文の値をアプリの記録で書き直す「書き直す」ができる。注文の値とアプリの記録が違う・無い・読めないときは知らせる（表示名 `fromLabel`/`toLabel` の違いは見ない）。
- Shopify の注文ページ: ブロック拡張 `extensions/order-adjustments-block`（`admin.order-details.block.render`）。`GET /api/admin/order-adjustments?orderId=…` を読んで行を出すだけ。「変更・履歴を開く」でアプリの画面へ（リンクは `app:/app/order-adjustments?orderId=…`。管理画面で開けるかは開発ストアで要確認）。ブロックは、注文ページの「アプリ」のブロックから足す。
