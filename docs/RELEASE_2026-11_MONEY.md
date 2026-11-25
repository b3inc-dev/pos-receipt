# お金の直しを本番に出す手順（2026-11）

対象: #11（お金の直し）・#16（取れなかったら確定しない）・#13（GDPR・旧ギフトカード集計を既定 OFF）

- この手順は下書きです。マージ・本番に出す操作はしていません
- T がやるところは **【T】**、エージェントがやるところは **【係】** と書きます
- T のところは、1 回あたり数分で終わるようにしています

---

## 0. 先に知っておくこと

### PR どうしのぶつかり（2026-11-22 に `git merge-tree` で確かめた）

| 組み合わせ | 結果 |
|---|---|
| #11 だけ main へ | ぶつからない |
| #16 だけ main へ | ぶつからない |
| #13 だけ main へ | **ぶつかる**（`docs/DECISIONS.md`・`docs/SHOPIFY.md`）。直す PR #40 がある |
| #11 のあと #16 | **ぶつかる**（`api.settlements.create.tsx`・`settlementApiError.server.ts`） |
| #11 のあと #13（#40 込み） | **ぶつかる**（`settlementEngine.server.ts`・`docs/ARCHITECTURE.md`） |
| #16 のあと #13（#40 込み） | **ぶつかる**（`salesChannelEngine.server.ts`・docs 2 つ） |
| #41（料金）と #13 | `package.json` の 1 行がぶつかる |
| #41 と #11・#16 | ぶつからない |

- #11 と #16 のぶつかりは「エラーの返し方を 1 つずつ足した」同じ場所です。**両方残す**だけで直ります（#11 の 409 と #16 の 500 を両方）
- #13 は `settlementEngine.server.ts` の税の関数を別ファイルへ移します。#11 のお金の直しを消さないように、#11 のほうを残して合わせます
- どの PR も `prisma/` を変えていません（DB の形は変わらない）。前の版に戻しやすいです

### 安全な順番

1. POS の拡張を出す（#11 の中身。公開用・自社用の両方）
2. #11 を main へ
3. 旧ギフトカード集計を OFF にして保存
4. #16 を main へ
5. #13 を main へ
6. 本番で確かめる

#41（料金）は今回に入れません。#13 のあとに別の日に出します（`package.json` を #13 に合わせ、migration の時刻を付け直してから）。

**理由**
- #11 は POS の拡張を先に出す決まりがある（`docs/DEPLOY_PUBLIC_AND_INHOUSE.md` 4.1）。お金の直しなので一番先
- #16 は「旧ギフトカードの取得に失敗したら精算を確定しない」を含む。OFF にしてから入れれば、この取得そのものをしないので止まらない
- #13 は docs と整理が中心。最後に入れて、#11・#16 に合わせ直す

### main へマージすると Render で何が起きるか

- `pos-receipt`（公開用）と `pos-receipt-ciara`（自社用）の **両方** が main を見ていて、マージのたびに自動で本番に出ます
- 流れ: build（`npm install && npx prisma generate && npm run build`）→ `npm run render:migrate`（今回は新しい migration なし）→ `npm run start`
- 数分かかります。**2 つとも「Live」になってから次のマージ** をします
- この docs の PR をマージしても同じく Render が動きます（中身は変わりません）

---

## 1. 【係】マージの前にそろえること

- [ ] #11 の最新の head で `npm test` と CI が通っている
- [ ] #11 の draft を外し、T に承認のカードを出す
- [ ] 下の 2. のコマンドを打つ #11 の head の番号（SHA）を T に伝える

---

## 2. 【T】POS の拡張を出す（両方のアプリ）

パソコンで、`pos-receipt` のフォルダで打ちます。

```bash
git fetch origin
git switch --detach origin/cursor/decision-audit-p0-money-print-0b3e
npm ci
npm run deploy:public
npm run deploy:inhouse
git checkout -- extensions/common/appUrl.js
git switch main
```

- `deploy:public` → 公開用「POS Receipt」へ
- `deploy:inhouse` → 自社用「POS Receipt - Ciara」へ
- 途中で「リリースしますか」と聞かれたら Yes
- 最後の `git checkout --` は、出すときに書き換わったファイルを元に戻すためです（コミットしない）

新しい拡張は古いサーバーのままでも動きます。お金は動きません。
ただし前からある「返金未確認」の登録の「Shopify 返金を確かめる」は、#11 を main に入れるまでエラーになります。**まだ押さないでください。**

---

## 3. 【T】POS が新しい拡張を読んだか確かめる

1. 店の iPad の Shopify POS を一度とじて、開き直す
2. POS Receipt のタイルから「特殊返金」を開く
3. 前からある未確認の日を開き、登録に **「返金未確認」** の印と **「Shopify 返金を確かめる」** のボタンが出ていれば OK（押さない）

出ないときは、POS を開き直すか、少し待ってからもう一度。

---

## 4. 【T】#11 を main へマージ

1. カードで承認 → マージ
2. Render の `pos-receipt` と `pos-receipt-ciara` が両方「Live」になるまで待つ

【係】マージのあと: Render のログに起動エラーがないか、`/app` が開くかを見る。

---

## 5. 【係】#16 を main に合わせ直す

- main（#11 入り）を #16 に取り込む PR を作る
- ぶつかる 2 ファイルは **両方残す**:
  - `app/utils/settlementApiError.server.ts`: `SpecialRefundPendingError` → 409 と `UpstreamAggregationError` → 500 の両方
  - `app/routes/api.settlements.create.tsx`: import 2 つと、catch の中の 2 つの分かれ道の両方
- `npm test`・CI が通ったら T にカード

---

## 6. 【T】旧ギフトカード集計を OFF にして保存（#16 の直前）

T の決定: OFF（この店はギフトカードを POS でだけ売るので、POS の注文に載る）。

1. Shopify 管理画面 → アプリ「POS Receipt - Ciara」→ 精算設定
2. **「旧ギフトカード API 集計（検証用・ON で有効）」のチェックを外す**
3. 「保存」→「保存しました。」が出れば OK

- #13 で既定は OFF になりますが、**前に保存した ON はそのまま残ります**。だから手で外します
- 公開用「POS Receipt」を本番で使っている店があれば、その店も同じところを確かめます

---

## 7. 【T】#16 を main へマージ

1. カードで承認 → マージ
2. Render 2 つが「Live」になるまで待つ

入ったあとの変化: Shopify から注文を取りきれなかった日は、精算が **確定せずに止まり**、「集計は確定していません。しばらくしてから再試行してください」と出ます。これは正しい動きです。時間をおいてやり直してください。

---

## 8. 【係】#13 を main に合わせ直す → 【T】マージ

【係】
- #40（main を #13 に取り込む）を入れてから、さらに今の main（#11・#16 入り）を取り込む
- `settlementEngine.server.ts`: #11 の特殊返金の直しを残す。#13 の税の関数の移動（`settlementTaxPure.server.ts` からの再エクスポート）だけ足す
- `salesChannelEngine.server.ts`: #16 のページのガードを残し、#13 の import の差し替えだけ足す
- docs のぶつかりは両方の内容を残す
- `npm test`・CI・`npm run verify:toml-app-mode` が通ったら T にカード

【T】カードで承認 → マージ → Render 2 つが「Live」になるまで待つ

#13 は Shopify の設定（toml）を変えないので、`deploy:public` / `deploy:inhouse` はいりません。

---

## 9. 【T】本番で確かめる（全部入ったあと）

### 9.1 1 日分の精算

1. 1 店を選び、POS で今日（または昨日）の精算の画面を開く
2. 合計・現金・商品券の数字が、いつもの見え方と合っているか見る
3. 精算する（印字も 1 回）

- 止まって「集計は確定していません」と出たら、数分おいてやり直す
- 「Shopify 返金の結果が分かっていません」と出たら、下の 9.2 を先にやる

### 9.2 返金未確認の登録（1〜5 件。どれも 3 日以上前）

前からある登録なので、ボタンは **Shopify の注文を読み直すだけで、返金はしません**（2 回返金にはなりません）。

1. POS の「特殊返金」→ 印「返金未確認」のある日を開く
2. 登録ごとに **「Shopify 返金を確かめる」** を押す
3. 出た結果ごとに:

| 出たもの | すること |
|---|---|
| 「確かめました」など成功 | 終わり |
| 返金の候補が出る | Shopify 管理画面のその注文の返金と見比べて、合うものを選ぶ |
| 候補がない・合わない | Shopify 管理画面で返金がないことを確かめてから「Shopify に返金はありません」 |
| エラー | 時間をおいてもう一度押す |

4. 全部終わったら、その日の精算をやり直す必要があるかを見る（もう精算済みの日はそのままでよい）

- 無効にする・登録し直すは **しない**（2 回返金・2 回計上になりうる）

### 9.3 【係】ログ

- Render の両方のログで、`UPSTREAM_INCOMPLETE` や 409 が続いていないか
- `idempotencyKey missing` が出ていないか（出るなら古い POS が残っている。3. をやり直す）

---

## 10. 前の版に戻す

困ったら、上から順に。

1. **Render を前の版に戻す**: Render → `pos-receipt` → Events（Deploys）→ 1 つ前の「Live」だった版 → Rollback。`pos-receipt-ciara` も同じ
   - DB の形は変えていないので、戻しても DB はそのまま使えます
2. **main も戻す**: 【係】が戻す PR（revert）を作る → 【T】カードで承認 → マージ（戻さないと、次のマージでまた出てしまう）
3. **POS の拡張**: 新しい拡張は古いサーバーでも動くので、普通は戻さなくてよい。どうしても戻すときは Partner Dashboard → アプリ → Versions → 前の版を Release（公開用・自社用の両方）
4. **旧ギフトカード集計**: OFF のままでよい。商品券の数字が足りないと分かったときだけ、精算設定で ON に戻して保存

確かめ直した「返金未確認」の結果は DB に残ります。前の版に戻しても消えません。

---

## 11. 一覧（チェック用）

- [ ] 【T】2. POS の拡張を出す（public・inhouse）
- [ ] 【T】3. POS を開き直して「Shopify 返金を確かめる」が見える
- [ ] 【T】4. #11 マージ → Render 2 つ Live
- [ ] 【係】5. #16 を合わせ直す
- [ ] 【T】6. 旧ギフトカード集計を OFF で保存
- [ ] 【T】7. #16 マージ → Render 2 つ Live
- [ ] 【係】8. #13 を合わせ直す →【T】マージ → Live
- [ ] 【T】9.1 1 日分の精算
- [ ] 【T】9.2 返金未確認を確かめる
- [ ] 【係】9.3 ログ
