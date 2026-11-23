# 会計の前に商品券の額面を入れる（会計後に自動で登録）

T の決定（2026-11-23、カード）: 商品券釣有りの会計では、会計の前に「商品券」タイルで額面を入れておき、注文ができたら、後から登録したのと同じ商品券調整（`SpecialRefundEvent`・注文の `pos.adjustments`・精算）を自動で作る。後から「商品券」タイル・取引詳細の「商品券釣銭調整」で登録するやり方も残す。

あわせて、ホームのタイルを「返金」と「商品券」の 2 つに分けた（T の決定 2026-11-23、カード）。

## 店舗での流れ

1. 商品をカートに入れる
2. ホームの「商品券」タイルを押す（カートに商品があると、最初に額面の入力が出る）
3. 額面（例 5,000）を入れて「カートに入れる」。タイルのサブタイトルが「額面 5,000円 入力済み」になる
4. いつもどおり「商品券釣有り」で会計する
5. 会計後の画面に「商品券 5,000円（釣銭 700円）を登録しました」と出る

カートが空のときに「商品券」タイルを押すと、今までどおり後から登録する一覧が出る。額面を入れる画面からも「注文の一覧を開く」で一覧へ行ける。

## しくみ

| 段 | どこ | 何をするか |
|----|------|-----------|
| 入力 | `VoucherCartScreen.jsx`（`pos.home.modal.render`） | Cart API `addCartProperties({ "_pos_receipt_voucher_face": "5000" })`。拡張の storage に「この端末で入れた」目印（12 時間で古い扱い） |
| 注文 | Shopify | カートの項目は会計後も注文に残る。「_」始まりは POS の画面・レシートに出ないが、注文（管理画面・Admin API・webhook）には書かれる（shopify.dev Cart API, 2026-07） |
| 自動登録 | `VoucherPostPurchaseBlock.jsx`（`pos.purchase.post.block.render`） | 目印があるときだけ `POST /api/voucher-adjustments/from-cart`（注文 ID）。結果を一行で出す。目印が無い会計では何も出さず、サーバーも呼ばない |
| 拾い直し | `webhooks.orders.updated.tsx` | 知らせの `note_attributes` に額面があれば同じ関数を呼ぶ（会計後の画面を閉じた・端末の目印が消えたとき） |
| 登録 | `voucherCartEntry.server.ts` `registerVoucherFromCartEntry` | 注文を読み直し、`customAttributes` の額面・商品券で払った額（`fetchOrderVoucherApplied`）から、後から登録したときと同じ行を作り、`pos.adjustments` と売上サマリーを直す |

### 決まり

- 釣銭 = 額面 − 商品券で払った額（後からの登録と同じ `voucherChangeOf`）。数える日は注文の日。
- Shopify の返金はしない（商品券調整はいつも記録のみ）。
- 同じ注文で 2 回作らない: 行の id を `pos_vc_cart_<注文の数字>` にして主キーで止める。手で登録した商品券調整（有効）が先にあれば作らない。
- 作らないとき（会計後の画面にわけを出す）: 商品券の支払いが無い（`no_voucher_payment`）、キャンセル済み、管理画面の商品券設定で「商品券機能」か「手動調整」がオフ（`disabled`）、注文を読めない。
- 額面を入れたまま会計しなかったカートは、項目が消えるだけで何も登録しない。

## 未確認（開発ストアで確かめる）

- カートの項目が注文の `customAttributes`（GraphQL）と webhook の `note_attributes`（REST 形）のどちらにも同じキーで入ること。docs は「注文に書かれる」とだけ書いていて、欄の名前は書いていない。
- `pos.purchase.post.block.render` で何も描かないとき、空の枠が出ないか。
- 会計で `orders/updated` が届くか（届かなくても、会計後の画面で登録できていれば困らない）。
