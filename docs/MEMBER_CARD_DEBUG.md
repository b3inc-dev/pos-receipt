# 会員証（LIFF）で表示されないときの原因の追求

## 1. 「LINE認証に失敗しました」／「トークンの有効期限が切れました」

### ログで確認する

Render のログで次のような行を探す。

- `[member-card] LINE verify failed: 400 {"error":"invalid_request","error_description":"IdToken expired."}`
  - **原因**: id_token の有効期限切れ。
  - **対処**: 会員証ページを**再読み込み**する。PCブラウザで開いている場合は、**LINEアプリから同じURLを開き直す**と新しいトークンが取得できる。

- `LINE verify failed: 401` や `client_id` まわり
  - **原因**: LINE_CHANNEL_ID の不一致や設定ミス。
  - **対処**: 環境変数 `LINE_CHANNEL_ID` が、LIFF を登録している LINE チャネルの Channel ID と一致しているか確認。

---

## 2. 「LINE連携済み会員が見つかりません」（API が 404 を返す）

### ログで確認する

Render のログで次のどちらかが出ているか確認する。

**パターン A**

```text
[member-card] No customers in query result. sub (last4): xxxx | Check metafield 'ストア分析で絞り込む' for socialplus.line
```

- **意味**: 顧客検索のクエリで 0 件しか返ってきていない。
- **よくある原因**:
  1. 顧客メタフィールド `socialplus.line` が「**ストア分析でデータを絞り込む、またはグループ化する**」になっていない。
  2. そのストアに、指定した LINE ID（sub）を `socialplus.line` に持つ顧客がまだいない。

**パターン B**

```text
[member-card] Query returned N customers but no line match. sub (last4): xxxx | sample lineMetafield (last4): xxxx
```

- **意味**: 顧客は N 件返っているが、どの顧客の `socialplus.line` も、今回の LINE の sub と一致していない。
- **よくある原因**:
  1. 表示したい会員の顧客に、**正しい LINE ユーザー ID** が `socialplus.line` で入っていない。
  2. LINE の sub と、メタフィールドの値の**表記ゆれ**（前後の空白、大文字・小文字はコード側で吸収しているが、 typo や別IDは吸収されない）。

### チェックリスト

1. **メタフィールドの検索設定**
   - 設定 → カスタムデータ → 顧客
   - 名前空間 `socialplus`・キー `line` の定義で「**ストア分析でデータを絞り込む、またはグループ化する**」がオンか。

2. **該当顧客のメタフィールド値**
   - 管理画面で、その会員の顧客レコードを開く。
   - `socialplus.line` に、**LINE のユーザー ID（会員証取得時に API が受け取っている sub）** が入っているか。
   - ログの `sub (last4): xxxx` と、顧客の `socialplus.line` の**末尾4文字**が一致するか照合するとよい。

3. **CRM PLUS on LINE 連携**
   - LINE 連携で `socialplus.line` を書き込んでいる場合、その連携が完了しているか、該当顧客に正しく反映されているか。

---

## 3. まとめ

| 画面の表示                     | ログのヒント                          | まず確認すること |
|------------------------------|----------------------------------------|------------------|
| トークンの有効期限が切れました | `IdToken expired`                      | ページ再読み込み／LINEアプリから開き直し |
| LINE認証に失敗しました        | `LINE verify failed: 400/401`          | LINE_CHANNEL_ID、LIFF のチャネル |
| LINE連携済み会員が見つかりません | `No customers in query result`         | メタフィールドの「ストア分析で絞り込む」と、該当顧客の存在 |
| LINE連携済み会員が見つかりません | `Query returned N customers but no line match` | 顧客の socialplus.line の値と、ログの sub (last4) の一致 |
