# POS_LITE — Shopify POS Lite に切り替えたときの POS Receipt の対応表

Shopify POS を **POS Lite**（POS Pro を付けない店）で使うとき、POS Receipt がどこを受け持つかと、**Lite の実機で確かめる項目**をまとめます。

- 正本の要件: T さんの「POS Lite 切替の要件」（2026-11-23 3:12 JST、連絡帳 Issue #39 コメント 7083431678）と、3:08 の方針・3:15 の決定（同 7083379730・7083361354）、3:12 の要件での置きかえ（同 7083432165）。
- この文書が扱うのは **POS Receipt の分だけ**です。店頭受取・配送・混在の会計（Location Stock）、在庫（POS Stock）、ポイント（Shop Point）は各アプリの docs を見てください。
- コードの事実は `main`（`b17f8a4`、2026-11-23 時点）で確かめたものです。開いている PR の中身は「予定」と書き分けます。

## 0. 読み方（事実・推測・未確認）

| 印 | 意味 |
|---|---|
| **事実（コード）** | `main` のコードで確かめた |
| **事実（Shopify）** | Shopify ヘルプの Lite / Pro の比較表に書いてある（下の「出典」） |
| **決定（T）** | T さんが決めた（日時つき） |
| **推測** | 上の事実からの見込み。実機で確かめるまで仕様にしない |
| **未確認** | まだだれも確かめていない |

**名前のまぎらわしさ**: アプリの料金プランにも「Lite / Pro」があります（`app/utils/planFeatures.server.ts`、売上サマリー・予算・入店数は アプリの Pro 以上）。この文書の「Lite」は **Shopify POS Lite**（Shopify 側の POS の契約）のことで、アプリのプランとは関係ありません。自社用（Ciara）は アプリのプランに関係なく全機能が使えます。

## 1. Shopify 側で Lite になると使えないもの（POS Receipt に関係する行）

**事実（Shopify）**: Shopify ヘルプの比較表で「すべての有料プランに含む」が ✘ で、POS Pro だけに ✔ がある行のうち、POS Receipt に関係するもの。

| Shopify の表の行（原文） | Lite | POS Receipt との関係 |
|---|---|---|
| Daily sales reports | ✘ | 日次の売上・精算・点検を POS Receipt で出す（2 章） |
| In-app retail store analytics | ✘ | 売上サマリー（2 章） |
| Add staff to sale | ✘ | 販売担当（2 章の「販売担当」） |
| Multiple printed receipt copies per transaction | ✘ | 印字の枚数（3 章の L1） |
| Exchanges | ✘ | 交換は「返品・返金」と「新しい会計」に分かれる（推測。3 章の L6） |
| Order cancellations | ✘ | POS からの注文の取消（3 章の L7） |
| Retail staff permissions and management | ✘ | スタッフの権限。T さんは「全員が返金・値引き可能」で運用する（要件） |

Lite でも使える行（✔ / ✔）: Refunds・Custom printed receipts・Email/SMS receipts・Cash tracking・Discount codes and manual discounts・Custom sales・Sell and redeem gift cards・Customizable smart grid。

**未確認**: 比較表は POS の標準の画面の機能の表です。**アプリから印字する Printing API（`shopify.printing.print`）や、アプリのタイル・注文詳細のメニューが Lite で制限されるかは、表に書いていません。** 3 章で実機で確かめます。

## 2. POS Receipt の受け持ちの対応表

| 領域 | 要件（T さん 3:12 ほか） | 今の main（事実・コード） | 予定（開いている PR・決定） |
|---|---|---|---|
| **日次の売上** | POS 内の日次売上レポート・分析の代わりに、売上・返金・決済手段別を集計する | 精算プレビュー（`app/services/settlementEngine.server.ts`）が店（`location_id`）× 日で集計。売上サマリー（`salesSummaryEngine.server.ts`）は精算プレビューを使い直す。POS のタイル「売上サマリー」あり。公開用では アプリの Pro 以上（自社用は全部） | 精算の数え方を店ごとに選ぶ #57、試験の穴埋め（連絡帳 7092122068 の依頼 2） |
| **精算** | 精算を出して印字する | POS タイル「精算」。`main` の印字は店ごとの `printMode`（既定 `order_based` = 精算用の注文を作り Shopify の標準のレシートで印字、または `cloudprnt_direct`）。印字設定で Printing API の「印字」ボタンも出せる | #22（#53 で main に追いつかせ中）で Printing API に一本化し、精算用の注文をやめる。Ciara の運用開始は #22 と #69（レイアウト編集）のあと（決定 T 2026-11-22） |
| **点検** | 点検を出して印字する | 精算と同じタイルで「点検レシート」。同じ日に何回でも出せる（点検は重複防止の対象外。`api.settlements.create.tsx`）。保存する金額は 0 | #78: 毎回その時点の金額を記録・完了画面の文言（#53 の上）。何回でも発行は決定（T 2026-11-22） |
| **領収書** | （要件の表には無いが、依頼 3 の範囲）| POS タイル「領収書」で注文を探して発行・再発行、`ReceiptIssue` に記録。印字は印字設定で Printing API をオンにした店だけ「Printing API で印字」、それ以外は従来の導線（注文経由 / CloudPRNT） | #22 で Printing API に一本化。#79 で発行者を記録（#53 の上に入った）。但し書きの運用は #86 |
| **販売レシートの印字** | （同上）| POS タイル「販売レシート」と注文詳細のメニューから、注文を選んで Printing API（`/api/print/sales/:orderId`）で印字。会計のときに自動では出ない（手で押す） | #69（4 種のレイアウト編集）、#83（レイアウトを印字につなぐ） |
| **返金の計上店** | 返金自体は Shopify 標準で行い、POS Receipt は **返品した店への計上** を受け持つ。計上先は「返金した POS の店」（決定 T 3:15） | 設定 `refundAggregationLocationMode`（既定 `order_transaction`。`refund_transaction_pos_location` にすると返金した POS の店を先に見る）と、POS 以外の返金の扱い（`nonPosRefundFallbackMode`・`nonPosRefundAttributionEnabled`）。詳しくは `docs/BUSINESS_RULES.md` 5 章 | Ciara でどちらの設定にするかは T さんの判断待ち（4 章） |
| **販売担当** | 商品・数量別の販売担当の割当と、会計後・部分返品のときの訂正を独自の画面で保存し、Ciara に反映（POS Receipt + Ciara System） | 注文詳細 API が明細の `staffMember` を名前で返し、POS の詳細に「販売: …」と出すだけ。精算・領収書の計算には使わない（`docs/BUSINESS_RULES.md` 8 章） | #84（注文の通知から帰属スタッフを記録・#53 の上に入った）。**作り直し**: お金の直し（#11 → #16 → #13）と #22 が main に入ったあと、新しい PR で。書き方は ciara-system #883 の受け取り方に合わせ、注文のメタフィールド `pos.line_item_staff_attributions` に署名付きで書く（鍵 `CIARA_POS_ATTRIBUTION_HMAC_SECRET`）（決定 T 3:15、連絡帳 7083361354）。始める時期は T さんの判断待ち |
| **送料の行**（Location Stock の Lite 配送） | 送料の行を売上・ポイントの対象にするかを管理画面で選べる（T 3:40） | `_lsi_fee="1"` かつ `_lsi_fee_sales="0"` の明細を精算・売上サマリーの売上から外す（#87 で main に入った。`docs/BUSINESS_RULES.md` 7.1）。領収書の金額は全額のまま | — |

**推測**: 「Add staff to sale」が Lite で ✘ なので、Lite の店の注文では明細の `staffMember`（と #84 が通知から読む帰属スタッフ）が空になる見込みです。だから販売担当は独自の画面での作り直しが要る、というのが 3:15 の決定の前提です。空になるかは 3 章の L3 で確かめます。

## 3. Lite の実機で確かめる項目

開発ストアか Ciara の 1 店を POS Lite にして確かめる想定です（どの店でやるかは未定）。結果は表の「結果」に書き足します。

| # | 確かめること | なぜ | 見込み | 結果 |
|---|---|---|---|---|
| L1 | **1 回の取引でレシートを何枚も印字できるか**。(a) Shopify の標準のレシートの 2 枚目、(b) POS Receipt の Printing API で、同じ注文の販売レシートと領収書を続けて出す、(c) 同じ精算を 2 回出す | 比較表で「Multiple printed receipt copies per transaction」が Pro だけ。控えを 2 枚出す運用があるかは T さんの判断待ち（4 章） | (a) は出せない（事実・Shopify）。(b)(c) は **未確認**（アプリの印字が数に入るか表に書いていない） | |
| L2 | POS Receipt のタイル（精算・領収書・販売レシート・売上サマリー・特殊返金・商品券）と注文詳細のメニューが出て、開けるか | アプリの画面が Lite で制限されるか表に書いていない | 出る（推測） | |
| L3 | Lite で会計した注文の明細の `staffMember` と、注文の帰属スタッフ（#84 が読むもの）が空か | 販売担当の作り直しの前提 | 空（推測） | |
| L4 | 返金した店への計上: (a) 同じ店の POS 注文、(b) **他店の POS 注文**、(c) **EC の注文** を Lite の POS で返品・返金できるか。できたとき、返金の取引に POS の店が付くか、精算でどの店に載るか（`refundAggregationLocationMode` の 2 つの設定で） | 3:12 の要件。「どの店でも返品」は Pro の機能という説明がある（連絡帳 7083361354、Shopify の記述は未確認）。アプリで全部を代わりにする実装は今は求めない（7083432165） | **未確認** | |
| L5 | 部分返品（3 点のうち 1 点）のとき、精算の点数・金額・返金件数が合うか | 3:12 の切替条件（3 点購入・1 点持ち帰り・2 点配送・後日 1 点返品） | 合う（推測。返金の数え方は Lite で変わらないはず） | |
| L6 | 交換ができないとき、返品と新しい会計を別々にした日の精算が合うか | 比較表で Exchanges が Pro だけ | 返金と売上が別々に載る（推測） | |
| L7 | POS で注文を取り消せないとき、取り消しの代わりの操作（返金・管理画面での取消）が精算でどう載るか | 比較表で Order cancellations が Pro だけ。精算は当日 `updated_at` の取消済み注文を拾う（`docs/BUSINESS_RULES.md` 6 章） | **未確認** | |
| L8 | Location Stock の Lite 配送の送料の行が、精算・売上サマリーで設定どおり外れるか / 含まれるか | #87 の確かめ | 合う（推測。合成データの試験は済み） | |
| L9 | Printing API の印字（販売レシート・領収書、#22 のあとは精算・点検も）が Lite の POS で出るか。Printing API は API 2026-07 以上・POS 11.11 以上が要る（`extensions/common/printApi.js`） | #22 で印字を Printing API に一本化するため | 出る（推測） | |
| L10 | 現金の精算: 比較表で Cash tracking は Lite でも ✔。POS Receipt の精算の現金（現金の上限の調整）が Pro のときと同じ値になるか | 現金の納金額との照合 | 同じ（推測） | |

まとめの確かめ（3:12 の切替条件）: 同じ商品を 3 点買い、1 点持ち帰り・2 点配送、販売担当を分け、後日 1 点返品 → Location Stock（配送・履行）、POS Receipt（担当・返金の集計）、Shop Point（ポイントの調整）の流れが Lite の実機でそろうこと。**「代わりの設計がある」と「店で切り替えられる」は分けて判断する**（要件）。販売担当の作り直しが済むまで、POS Receipt の分は「代わりの設計がある」止まりです。

## 4. T さんの判断待ち（この文書では決めない）

- 販売担当の作り直しを始める時期（#11 → #16 → #13 → #22 が main に入ったあと。#84 の orders/create の購読を外すか）
- POS Lite で他店・EC の注文を返金できなかったときの代わり、Ciara の返金の計上店の設定（`refundAggregationLocationMode`）
- 控えを 2 枚出す運用があるか（L1）
- 実機で確かめる店・時期

## 5. 出典

- Shopify ヘルプ「Managing your POS app subscription」の比較表（2026-11-23 に読んだ。ページに更新日の記載なし）: https://help.shopify.com/en/manual/sell-in-person/getting-started/identify-your-pos-needs
- T さんの要件・決定: 連絡帳 Issue #39 のコメント 7083431678（3:12 要件）・7083379730（3:08 方針）・7083361354（3:15 決定）・7083432165（置きかえ）・7083882023（送料の行）・7092122068（この文書の依頼）
- コード: `main` `b17f8a4`（2 章の表のパス）。現行の業務ルールは `docs/BUSINESS_RULES.md` を正とする
