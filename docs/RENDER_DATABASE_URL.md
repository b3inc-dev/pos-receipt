# DATABASE_URL の見つけ方（Render）

**DATABASE_URL** は、Render で作成した **PostgreSQL データベース** の「接続用の URL」です。  
Web サービス用の環境変数には、**この URL をそのままコピーして** 入れます。

---

## 前提：PostgreSQL を先に作っておく

DATABASE_URL を使うには、**Render 上に PostgreSQL を 1 つ作っておく**必要があります。

- まだ作っていない場合:  
  Render ダッシュボード → **New +** → **PostgreSQL** → 名前（例: `pos-receipt-db`）を付けて **Create Database**

---

## DATABASE_URL をコピーする手順

1. **Render ダッシュボード**（https://dashboard.render.com）を開く
2. 左の一覧またはダッシュボードから、**作成した PostgreSQL のサービス**（例: `pos-receipt-db`）をクリックして開く
3. そのデータベースの画面で、**「Connect」** または **「Connection」** のようなセクションを探す
4. 次のような項目が並んでいます：
   - **Internal Database URL**（推奨）
   - External Database URL
   - そのほか（Host, Port, Database, User, Password など）
5. **「Internal Database URL」** の右にある **コピーボタン（📋）** をクリックする  
   - または、表示されている長い文字列をすべて選択してコピーする
6. コピーした文字列が **DATABASE_URL** の中身です  
   - 形の例:  
     `postgresql://ユーザー名:パスワード@ホスト名/database名?sslmode=require`

---

## Web サービスの環境変数に入れる

1. **pos-receipt** の **Web サービス** の画面を開く
2. 左メニューまたは上部の **「Environment」** をクリック
3. **Environment Variables** の **「Add Environment Variable」** をクリック
4. **Key** に `DATABASE_URL` と入力
5. **Value** に、さきほどコピーした **Internal Database URL** をそのまま貼り付けて保存

これで「DATABASE_URL がどのことか」は「PostgreSQL の Internal Database URL」のこと、と覚えておけば大丈夫です。
