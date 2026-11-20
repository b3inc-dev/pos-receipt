# 精算レシート印字の1本化（Shopify Printing API）

最終更新: 2026-08-18  
対象: POS Receipt の精算レシート / 点検レシート（領収書は同一アダプタの後続対象）

関連:

- 要件書: `docs/posreceipt_requirements_spec.md`（本書で印字方針を改訂）
- 設定詳細: `docs/posreceipt_settings_detail.md`（§4.2.4 / §12 を改訂）
- Shopify Changelog: [POS UI extensions can now print directly to hardware receipt printers](https://shopify.dev/changelog/pos-ui-extensions-can-now-print-directly-to-hardware-receipt-printers)（2026-07-27）
- API: [Printing API (`shopify.printing`)](https://shopify.dev/docs/api/pos-ui-extensions/2026-07/target-apis/platform-apis/printing-api)

---

## 1. 結論

**印字経路は1本化できる。** ただし「精算注文を作る／作らない」までを同時に廃止する必要はない。

Shopify POS UI Extensions `2026-07` の Printing API（`shopify.printing`）が、POS にペアリング済みのハードウェアレシートプリンタへ HTML / 画像をダイアログなしで送れるようになった。現行の2経路は、この能力が無かったための回避策である。

| 現行経路 | 本来の役割 | 1本化後 |
|----------|------------|---------|
| `order_based` | ダミー精算注文を作り、POS 標準の注文レシート導線で印字する | **印字手段としては廃止。** Shopify 上の監査・検索用注文は設定で任意 |
| `cloudprnt_direct` | アプリがテキスト payload を返し、CloudPRNT プリンタがポーリングして印字する | **標準経路から降格。** POS 非対応機・バックオフィスプリンタ向けのレガシー |

**新しい標準経路は `shopify_printing` の1本。** 精算・点検は同じ HTML レンダラと同一の POS 印字呼び出しを使う。

即時に削除しないもの:

- CloudPRNT（POS 11.11 未満、`getPrinters()` 空配列、POS 非ペアのネットワークプリンタ）
- 精算注文作成（商業施設提出や本部監査で Shopify 注文が必要な店舗）

領収書は帳票レイアウトが別なので、印字アダプタだけ先に共通化し、帳票HTMLは後続フェーズで載せる。

---

## 2. 現行実装の問題

要件書は「CloudPRNT 対応 / 非対応の両対応必須」とし、印字方式で処理が大きく分岐している。

```
精算実行
 ├─ Location.printMode === cloudprnt_direct
 │    ├─ 精算注文を作らない
 │    ├─ DB 保存
 │    └─ printPayload テキストを返す（プリンタが GET /api/settlements/:id/print-payload をポーリング）
 └─ Location.printMode === order_based（デフォルト）
      ├─ Shopify に精算用ドラフト注文を作成・確定（GAS newSettlementFresh 相当）
      ├─ ノート / メタフィールドに精算本文を載せる
      ├─ DB 保存
      └─ スタッフが POS の注文一覧から当該注文を開き、標準レシートを印刷する
```

現場のコスト:

1. **店舗ごとに印字方式を覚えさせる**（管理画面の `printMode` と完了画面の案内が違う）
2. **order_based は印字そのものをアプリが完了できない**（完了画面は「注文を開いて印刷してください」）
3. **精算注文は売上を汚す**（SETTLEMENT タグで除外しているが、集計・権限・保護データの例外処理が増える）
4. **CloudPRNT は実機送信が未完了**（payload 生成とポーリング URL 案内まで。POS からプリンタへ送る導線は未実装）
5. **領収書は発行のみで、アプリからの印字が無い**

これらは「POS 拡張からレシートプリンタへ直接出せない」ことが根因だった。

---

## 3. Shopify Printing API で何が変わったか

### 3.1 できること

- POS UI Extensions API version **`2026-07`** の `shopify.printing`
- `getPrinters()` でデバイスに紐づくハードウェアプリンタ一覧（`id` / `name` / `connected`）
- `print(src, { printer })` で **ダイアログなし直印字**
- `print(src)` のみなら **システム印刷ダイアログ**（AirPrint 等）にフォールバック
- `src` はアプリの `application_url` 相対パス、または **同一オリジンの絶対 URL**
- ドキュメント取得時に **拡張のセッショントークン**が付く（既存の `authenticate.pos` と相性が良い）
- 対象ターゲットに `pos.home.modal.render` が含まれる（現行の精算モーダルから呼べる）
- レシートプリンタは **HTML と画像**を直接描画できる

### 3.2 制約（1本化の前提条件）

| 制約 | 影響 |
|------|------|
| ハードウェア発見は **Shopify POS 11.11.0 以降** | 未満では `getPrinters()` が空配列。ダイアログ印字は使える |
| PDF は直印字不可（`printer` 付きだと throw） | 精算レシートは **HTML（または画像）** で出す。PDF は使わない |
| `src` はアプリ `application_url` と同一オリジン必須 | 印字用 HTML は自アプリの GET エンドポイントで返す |
| コミュニティで `getPrinters()` 空配列の報告あり（11.10 時代） | 空配列時は必ずダイアログへフォールバックする |
| レシート幅・Star/Epson 固有コマンドの公式行列は未公開 | 58/80mm 向けのシンプルな HTML（等幅・大きめフォント・切れやすいレイアウト）にする |
| 現行拡張は `api_version = "2026-01"`、`@shopify/ui-extensions` は `2025.10.x` | **API バージョン上げが先行必須** |

旧 `shopify.print`（システムダイアログのみ、レシートプリンタ非対応）は deprecated。新規フローでは使わない。

---

## 4. 1本化の範囲

### 4.1 1本化する（必須）

- **印字の実行経路**: POS 拡張 → `shopify.printing.print` → ペアリング済みレシートプリンタ
- **帳票の生成**: バックエンドが精算データから印字用 HTML を1種類生成する
- **再印字**: 同一 HTML エンドポイントを再度 `print()` する（注文を開き直さない）
- **点検レシート**: 精算と同一レンダラ・同一印字呼び出し（表題と金額だけ変える）

### 4.2 印字から切り離す（設定で任意）

- **精算注文の作成**: 印字成功の条件にしない。監査・Shopify 検索が必要な店舗だけ ON
- `createSettlementOrderWhenPrinting` は「印字時」ではなく **「精算確定時に Shopify 同期するか」** に意味を変える

### 4.3 残すフォールバック（標準経路ではない）

- **システム印刷ダイアログ**: `getPrinters()` が空、または connected なし
- **CloudPRNT**: 既存店舗が POS 非ペアの CloudPRNT を使い続ける場合のみ。新規標準にはしない
- **order_based の人手印刷**: 移行期間の互換。新規店舗のデフォルトにはしない

### 4.4 この変更でやらないこと

- 精算エンジンの集計ロジック変更（対象日・支払内訳・特殊返金反映は現状維持）
- 領収書レイアウトを精算レシートに統合すること（帳票が違う。印字アダプタのみ共通化）
- CloudPRNT SDK を POS から直接叩くこと（Printing API で不要になる想定）
- PDF 帳票の導入

---

## 5. 修正後の要件定義

本章が要件書の印字関連の置き換え正本である。対応する章は `posreceipt_requirements_spec.md` にも反映済み。

### 5.1 前提（文書目的の更新）

- 日本の商業施設運用を想定し、Shopify POS 標準では不足する業務を補完する
- **精算・点検レシートの標準印字は Shopify Printing API とする**
- CloudPRNT と精算注文経由印字は、移行・例外店舗向けの互換経路とする
- 公開用 / 自社用の2種デプロイは従来どおり同一コードベース

### 5.2 機能要件: 精算の印字（旧 §6.7 / §6.8 の置換）

#### 標準経路 A. Shopify Printing API（必須）

- 精算（または点検）をアプリ DB に保存したあと、POS 拡張が印字用 HTML の URL を `shopify.printing.print` に渡す
- `getPrinters()` で `connected === true` のプリンタがあれば、そのプリンタへダイアログなし直印字する
- 接続プリンタが無い場合は、同一 URL をプリンタ指定なしで呼び、システム印刷ダイアログを出す
- 印字失敗時は精算レコード自体は保存済みのままにし、画面から再印字できる
- 精算注文の有無は印字成否に依存しない

#### 互換経路 B. CloudPRNT（任意・レガシー）

- ロケーション設定で明示的に CloudPRNT を選んだ店舗のみ
- 既存の `printPayload` / `GET /api/settlements/:id/print-payload` を維持する
- 新規店舗のデフォルトにはしない

#### 互換経路 C. 精算注文（任意・監査用）

- 「精算確定時に Shopify 精算注文を作る」は印字方式とは独立した設定とする
- ON のときのみ従来どおり精算注文・ノート・メタフィールドを作成する
- スタッフが注文画面から標準レシートを印刷する導線は、移行期間のみ残してよい
- 点検レシートは従来どおり精算注文を作らない（現行仕様を維持）

### 5.3 保存先（§6.9 は維持、印字結果を追加）

- 正本はアプリ DB
- 必要に応じて Shopify 注文メタフィールドにも要約保存（監査同期が ON のとき）
- 印字結果（成功 / ダイアログ / 失敗、使用プリンタ名、日時）を精算レコードまたは印字ログに残す

### 5.4 再処理（§6.10）

- 最新精算の再集計
- **再印字（Printing API。注文を開き直さない）**
- 過去日の再実行

### 5.5 管理画面: プリンタ / 印字設定（旧 §10.1 A の置換）

ロケーションごとの印字方式:

- `shopify_printing`（標準・新規デフォルト）
- `cloudprnt_direct`（レガシー）
- `order_based`（レガシー。人手で注文レシートを刷る）

ショップ全体:

- デフォルト印字方式（新規デフォルトは `shopify_printing`）
- ロケーション別上書きの可否
- 精算確定時の Shopify 同期（注文作成 / ノート / メタフィールド）※印字方式から独立
- 用紙幅（58mm / 80mm）。Printing API / CloudPRNT 共通
- CloudPRNT プロファイル（レガシー経路用）
- POS 11.11 未満・プリンタ未検出時のフォールバック（システムダイアログ / エラー表示）

### 5.6 印字方針（旧 §13 の置換）

#### 精算・点検

1. アプリが HTML をレンダリングする
2. POS 拡張が Printing API で印字する
3. プリンタ未検出時はシステムダイアログ
4. CloudPRNT / 注文経由は互換設定の店舗のみ

#### 領収書（後続）

- 同じ Print Adapter を使う
- 帳票 HTML は領収書テンプレートから生成する（精算レイアウトとは別）

### 5.7 帳票 HTML の要件

- Content-Type: `text/html; charset=utf-8`
- レシートプリンタ向け（幅 58mm / 80mm を設定から切替）
- 複雑 CSS・外部フォント・PDF 埋め込みは使わない
- ロゴは同一オリジンの画像、またはインライン
- 現行 `buildSettlementReceiptText()` と同等以上の項目を出す（表題、対象日、ロケーション、総売上、純売上、税、割引、返金、件数、点数、商品券釣有り、支払内訳）
- 精算設定の表示項目 ON/OFF・項目名・順を HTML にも適用する
- 点検時は表題を点検レシートにし、金額ルールは現行点検仕様に従う

### 5.8 API 要件（§21.3 の追加）

既存:

- `POST /api/settlements/preview`
- `POST /api/settlements/create` … 保存が主目的。`printMode === shopify_printing` のとき精算注文は設定 ON のときだけ作る
- `POST /api/settlements/recalculate`
- `POST /api/settlements/print` … 印字済みマーク（既存）
- `GET /api/settlements/:id/print-payload` … CloudPRNT 互換で残す

新規（標準印字）:

- `GET /api/settlements/:id/print.html`
  - POS Printing API がセッショントークン付きで取得する HTML
  - 同一オリジン、`text/html`
  - 存在しない ID / 他ショップは 404
- （任意）`GET /api/settlements/:id/print-preview` … 管理画面・POS プレビュー用。`s-embed` と併用可

create レスポンスに含めるもの:

- `settlementId`
- `printUrl`（HTML の相対または絶対パス）
- `sourceOrderId` / `sourceOrderName`（監査同期した場合のみ）
- レガシー `printPayload`（CloudPRNT 店舗のみ）

### 5.9 POS 画面（§23.1 の置換）

実行後:

- 標準: 保存成功後に自動印字（Printing API）。完了画面にプリンタ名または「システムダイアログ」を表示
- 失敗: エラーメッセージ + 「再印字」ボタン。精算は保存済み
- レガシー order_based: 従来どおり精算注文番号と「注文から印刷」案内
- レガシー CloudPRNT: 従来どおりポーリング URL 案内

履歴明細:

- 印字方式ラベルを `Shopify Printing` / `CloudPRNT` / `注文経由` に拡張
- 再印字ボタン（標準経路）

受け入れ条件:

- POS 11.11 以降かつレシートプリンタ接続時、精算完了後にダイアログなしで印字できる
- プリンタ未検出時、システムダイアログで印字できる
- 再印字が注文画面を経由せずにできる
- 精算注文作成が OFF でも印字できる
- 点検レシートも同じ印字経路で出せる

### 5.10 最終決定事項の更新（旧 §17 の印字関連）

- **標準印字は Shopify Printing API の1経路とする**
- CloudPRNT 直印字と注文経由印字は **互換経路** であり、新規必須ではない
- 精算注文作成は印字と独立した任意同期とする
- CloudPRNT 時に精算注文を作らない、という現行ルールは互換経路でも維持する
- 点検レシートは精算注文を作らない（現行維持）

---

## 6. 修正実装プラン

実装はドキュメント（本書）承認後に、以下の順でコードへ落とす。各フェーズは独立してマージ可能な粒度にする。

### Phase 0. 要件・設定の正本更新（本 PR）

- 本書の追加
- 要件書・設定詳細・NEXT_STEPS の印字章を改訂
- コード変更なし

完了条件: 標準経路 / 互換経路 / 精算注文の分離が文書上で矛盾しない。

### Phase 1. POS 拡張の Printing API 利用準備

目的: 印字呼び出しそのものを通す。帳票はまずプレーン HTML でよい。

作業:

1. `extensions/pos-smart-grid/shopify.extension.toml` の `api_version` を `2026-07` へ
2. `@shopify/ui-extensions` を 2026-07 系へ上げ、ビルドと既存タイルの回帰を確認
3. `GET /api/settlements/:id/print.html` を追加  
   - `authenticate.pos`（セッショントークン）  
   - 当面は `buildSettlementReceiptText()` を `<pre>` で包んだ HTML
4. `SettlementModal` 完了画面（および発行直後）で:
   ```js
   const printers = await shopify.printing.getPrinters();
   const printer = printers.find((p) => p.connected);
   const src = `/api/settlements/${settlementId}/print.html`;
   if (printer) await shopify.printing.print(src, { printer });
   else await shopify.printing.print(src);
   ```
5. 失敗時メッセージと「再印字」
6. `printMode === shopify_printing` を Location / 印字設定に追加。未設定は当面 `order_based` のまま（既存店を壊さない）

完了条件:

- 開発ストア + POS 11.11 + ペアリング済みプリンタで、精算完了後に紙が出る
- プリンタなし端末ではダイアログが開く
- 既存 `order_based` / `cloudprnt_direct` 店舗の挙動が変わらない

リスク: API バージョン上げで POS コンポーネントの破壊的変更。タイル4種を実機または POS シミュレータで確認する。

### Phase 2. レシート向け HTML レンダラ

目的: 商業施設提出に耐える見た目にする。

作業:

1. `app/services/settlementPrintHtml.server.ts`（仮）を追加。精算設定の項目 ON/OFF・順・表題を反映
2. 58mm / 80mm の幅指定（印字設定の `cloudprntPaperWidth` を汎用の `paperWidth` にリネーム、または併用）
3. 管理画面に HTML プレビュー
4. 点検レシートは同じレンダラで表題切替
5. 印字ログ（printer id/name、connected 直印字かダイアログか、成否）

完了条件: 実機 58/80mm で改行・金額桁・支払内訳が切れない。再印字が同じ HTML を使う。

### Phase 3. 印字と精算注文の分離

目的: 「印字するために注文を作る」をやめる。

作業:

1. `resolveSettlementOrderSyncOptions` を `printMode === "order_based"` 前提から外す  
   - 同期は「精算設定 / 印字設定の Shopify 同期フラグ」のみで決める
2. `shopify_printing` を新規ロケーションのデフォルトにする（既存 Location は据え置き）
3. 完了画面の「注文を開いて印刷」案内は `order_based` のときだけ
4. 管理画面の文言を「印字方式」と「Shopify 精算注文を作る」に分ける
5. 冪等キーから `printMode` を外すか、`shopify_printing` 移行後も再精算しない現行ルールを維持するか決定して実装する  
   - 推奨: 通常精算の冪等は `shopId + locationId + targetDate`（点検は除外のまま）。印字方式変更で二重精算しない

完了条件: 同期 OFF の店舗でも Printing API で紙が出る。同期 ON なら注文も残る。売上集計から精算注文が除外される現行ロジックは維持。

### Phase 4. 領収書への横展開（任意・推奨）

- `GET /api/receipts/:id/print.html`
- 領収書発行完了後に同じ `printWithFallback()` ヘルパーを呼ぶ
- 印字設定の `receiptPrintMode` を `shopify_printing` に寄せる

精算と領収書で Print Adapter が1本になる。帳票 HTML は別ファイルのままでよい。

### Phase 5. レガシー縮退（実機検証後）

- 新規店舗の UI から `order_based` 印字を外す（データ値は残す）
- CloudPRNT は「この店舗は POS 非接続プリンタを使う」場合のみ表示
- ドキュメントとチェックシートから「注文を開いて印刷」を標準手順から外す
- 実運用で Printing API が安定したあと、CloudPRNT payload 専用案内を管理画面の上級者向けに移す

削除判断は実機検証後。本プランではコード削除を必須にしない。

---

## 7. データ / 設定の変更点

| 箇所 | 変更 |
|------|------|
| `Location.printMode` | 値に `shopify_printing` を追加。既存行は移行しない |
| `PrintSettings.defaultPrintMode` | 同上。新規デフォルトを Phase 3 で `shopify_printing` に |
| `PrintSettings.createSettlementOrderWhenPrinting` | 「印字時」ではなく「精算確定時の Shopify 同期」とヘルプ文言を変更。`shopify_printing` でも参照する |
| `Settlement.printMode` | 実行時の経路を記録。`shopify_printing` を追加 |
| 印字ログ（新規・任意） | settlementId, printerId, printerName, method (`direct` / `dialog` / `cloudprnt` / `order`), status, error, createdAt |
| POS 拡張 | `api_version` 2026-07、共通 `printDocument(src)` ヘルパー |
| 新規ルート | `api.settlements.$id.print[.]html.tsx`（ファイル名は実装時に Remix のドット規則へ合わせる） |

マイグレーション: enum ではなく現行どおり `String` なので、値追加だけなら DB マイグレーションは不要。印字ログテーブルを足す場合のみ migration を切る。

---

## 8. テスト観点

### 8.1 必須（Phase 1 以降）

- POS 11.11 + Star / Epson 等のペアリング済みレシートプリンタで直印字
- プリンタ電源オフ / 未ペアでダイアログフォールバック
- POS 11.10 以下で `getPrinters()` 空 → ダイアログ（または案内）
- 再印字が同じ精算 ID の HTML を取る
- 点検レシートも印字できる
- 既存 `order_based` 店舗で精算注文作成が残る（Phase 3 前）
- 既存 `cloudprnt_direct` 店舗で payload URL が残る

### 8.2 回帰

- 精算プレビュー数値、冪等（同一日の二重精算防止）、SETTLEMENT 注文の集計除外
- 他タイル（特殊返金・領収書・売上サマリー）が API バージョン上げ後も起動する

### 8.3 非機能

- HTML エンドポイントがセッショントークン無しで 401
- 他ショップの settlementId で 404
- `src` が別オリジンにならない（`getAppUrl()` と `application_url` の一致）

---

## 9. 判断が必要な点（実装時の既定）

文書として既定を置く。実装時に覆す場合は本書を更新する。

| 項目 | 既定 |
|------|------|
| 既存店舗の `printMode` | 自動変換しない。管理画面から `shopify_printing` に切り替える |
| 新規ロケーションのデフォルト | Phase 3 以降 `shopify_printing` |
| 精算注文 | デフォルト OFF にしない（既存の order_based 店は ON のまま）。`shopify_printing` 新規店はデフォルト OFF を推奨 |
| プリンタが複数台 | 最初の `connected` を使う。選択 UI は後回し |
| 自動印字のタイミング | 精算 DB 保存成功直後。失敗しても精算は確定 |
| 領収書 | Phase 4。精算のアダプタが安定してから |

---

## 10. 関連ファイル（実装時）

| 目的 | ファイル |
|------|----------|
| POS API バージョン | `extensions/pos-smart-grid/shopify.extension.toml` |
| POS UI 依存 | `extensions/pos-smart-grid/package.json` |
| 精算モーダル | `extensions/pos-smart-grid/src/SettlementModal.jsx` |
| 印字ヘルパー（新規） | `extensions/common/printing.js` |
| 精算 create | `app/routes/api.settlements.create.tsx` |
| HTML 印字（新規） | `app/routes/api.settlements.$id.print.html.tsx` |
| CloudPRNT payload | `app/routes/api.settlements.$id.print-payload.tsx` |
| テキスト生成 | `app/services/settlementEngine.server.ts`（`buildSettlementReceiptText`） |
| HTML 生成（新規） | `app/services/settlementPrintHtml.server.ts` |
| 注文同期条件 | `app/services/settlementSyncSettings.server.ts` |
| 印字設定 UI | `app/routes/app.print-settings.tsx` |
| ロケーション設定 | `app/routes/app.settings.tsx` |
| 設定型 | `app/utils/appSettings.server.ts` |
| POS 認証 | `app/utils/posAuth.server.ts` |

---

## 11. まとめ

Shopify Printing API により、精算レシートを **「ダミー注文の標準レシート」と「CloudPRNT ポーリング」に分けていた理由は解消できる。**

やることは次の3点に尽きる。

1. POS 拡張を 2026-07 に上げ、保存済み精算の HTML を `shopify.printing` で出す
2. 精算注文作成を印字手段から外し、監査用の任意同期にする
3. CloudPRNT / order_based は既存店の互換として残し、新規標準は Printing API のみにする

これで現場の操作は「精算する → プリンタから出る」の1本になる。
