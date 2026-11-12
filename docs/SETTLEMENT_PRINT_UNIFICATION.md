# 精算・点検・領収書・販売レシート印字の一本化

PR #1 の docs 専用改訂を、ユーザー指示で上書きした実装正本です。

**対象外:** 通常の Shopify 販売注文（POS 標準の販売レシート導線）。本アプリが発行する精算・点検・領収書・販売レシート帳票のみ。

**本番操作はしない:** この変更は専用ブランチ / 実装 PR に保存する。main merge、本番 deploy、Shopify release、本番 DB の直接更新は行わない。

## 結論

アプリ独自印字は **Shopify POS UI Extensions `shopify.printing`（2026-07 / POS 11.11+）に統一**する。

| 旧 | 一本化後 |
|----|---------|
| `order_based`（SETTLEMENT / INSPECTION 注文 → POS 標準レシート） | **出力禁止。** 注文 create / update / fulfill を呼ばない |
| `cloudprnt_direct`（print-payload ポーリング） | **出力禁止。** GET は 410 |
| `preferPrintingApi` 等の切替 | **無効。** 保存値が false でも旧経路は復活しない |
| 監査用精算注文（#11 の明示 ON） | **採用しない** |
| 標準 | **`shopify.printing` + `/api/print/{settlement\|receipt\|sales}/:id`** |

集計エンジン（金額計算）は本 PR では変えない。#11 / #16 の返金・上流障害修正とは重複実装しない。

## 正規化（DB 行は自動変換しない）

- `Location.printMode` / `PrintSettings.defaultPrintMode` の旧値は **読み取りのみ**
- 実行時は常に `shopify_printing`
- 新規 Settlement の `printMode` は `shopify_printing`
- 冪等キーは `shopId:locationId:targetDate`。旧 `...:order_based` / `...:cloudprnt_direct` も検索し、再実行で精算行を増やさない
- 既存の精算注文・メタフィールド・Settlement 履歴は削除しない。再印刷はアプリ DB の保存済み金額を使う

## プリンタ

- `getPrinters()` の **`connected: true` のみ**直接印字に使う。未接続の先頭機は使わない
- 未接続は成功扱いにしない。ダイアログは明示操作でのみ開き、直接印字成功と区別する
- `print()` の resolve は **API 受付**。紙の排出完了ではない（`paperConfirmed: false`）
- 複数接続機は先頭の接続機へ送る
- 用紙切れ・切断はエラーメッセージで案内
- タイムアウト（20s）は成否不明。自動再送しない
- 二重タップは in-flight で拒否

## 再印刷

保存済み `Settlement` / `ReceiptIssue` から HTML を組む。ライブ再集計で金額を置き換えない。再印刷で注文・売上・返金・精算行は増えない。

## プランの区別

| 層 | 意味 | 印字との関係 |
|----|------|----------------|
| **アプリ Lite / Pro** | 本アプリの課金（`planFeatures.server.ts`） | 精算・領収書は全プラン。販売レシートは Lite+。売上サマリー等は Pro |
| **Shopify POS Lite / Pro** | Shopify 側の POS 契約 | 本コードは検出しない。Printing API は POS 11.11+ とペアリング済みレシートプリンタが前提 |

## 関連 PR（同時編集を避ける）

| PR | 関係 |
|----|------|
| #1 | 印字一本化の owner。本ファイルの初期 docs。実装はこの後続 PR |
| #11 | 印字の connected 検出と SETTLEMENT 抑制の一部。**返金 overlay / metafield 帰属は取り込まない** |
| #12 | 管理画面・属性。印字フラグ UI が重複しうる |
| #13 | docs / 税抽出。集計式は変えない |
| #16 | 上流ページ失敗時の fail-closed。本 PR は fetch ロジックを書き換えない |
| #18 | POS 販売担当。印字・返金ブランチを変更していない |
| #19 | 利用者マニュアル連動（main 未マージ） |

base: `main` @ `c69438d`
