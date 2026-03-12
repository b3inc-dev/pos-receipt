# サイトのアカウントページで会員証カードデザインを使う

ストアの「アカウント」ページで、LIFF会員証と同じプラスチックカード風デザインを表示する方法です。

## 1. 用意するもの

- **会員番号**: アプリ会員証と同じ値を使う場合は顧客メタフィールド `membership.id`。未設定なら `customer.id` を表示用に使えます。
- **ロゴ（必須）**: **テーマの assets に白ロゴを置き、アセットファイル名を指定します。** これにより同一オリジンになり、`mask-image` が効いて**ロゴの白い部分だけ**にランク色がのります。CDN の URL だと CORS でマスクが効かず白いままです。
- **会員ランク**（任意）: 顧客メタフィールド `vip.rank_name` があると、ランクに応じてロゴの白い部分だけがその色で光ります（ダイヤモンド＝水色、プラチナ＝銀紫、ゴールド＝金、シルバー＝銀、レギュラー＝白）。
- **ランクアップまで残り**（任意）: 顧客メタフィールド `vip.rank_decision_purchase_price`（ランク判定用累計購入額・円）があると、**LINE会員証（LIFF）**およびテーマの会員証ブロックで「ランクアップまで残り：¥X,XXX」を表示できます。閾値はテーマと同一（レギュラー→15,000円、シルバー→30,000円、ゴールド→50,000円、プラチナ→100,000円）。ダイヤモンド・VIPの場合は表示しません。

## 2. テーマに追加する方法

### 方法A: セクションとして追加（推奨）

1. **白ロゴ画像**をテーマの **assets** に追加する（例: ファイル名 `ciara-logo-white.png`）。透過 PNG の白ロゴを推奨。手順は下記「アセットにロゴを追加する方法」を参照。
2. テーマの `sections` フォルダに `member-card.liquid` を新規作成する。
3. 下記「セクション用 Liquid」のコードを貼り付けて保存する。セクション設定で「ロゴアセットファイル名」に上記のファイル名（例: `ciara-logo-white.png`）を指定する。
4. テーマエディタで「アカウント」テンプレートを開き、該当ページに「会員証カード」セクションを追加する。

### アセットにロゴを追加する方法

テーマの **assets** に画像を入れると、`asset_url` で同一オリジンとして読み出せ、会員証の「ロゴの白い部分だけにランク色」が有効になります。

**方法1: テーマエディタ（オンラインストア）**

1. 管理画面で **オンラインストア** → **テーマ** を開く。
2. 使っているテーマの **⋯（その他）** → **コードを編集** をクリック。
3. 左の **アセット（Assets）** を開く。
4. **アセットを追加**（または **Add a new asset**）をクリック。
5. **ファイルを選択** から、白ロゴの画像（例: `ciara-logo-white.png`）を選んでアップロード。
6. アップロード後のファイル名（例: `ciara-logo-white.png`）を、会員証セクションの設定「ロゴアセットファイル名」にそのまま入力する。

**方法2: Shopify CLI で開発している場合**

1. テーマのフォルダ内の `assets` ディレクトリに、白ロゴファイルを置く。  
   例: `themes/あなたのテーマ/assets/ciara-logo-white.png`
2. `shopify theme push` などでテーマをアップロードすると、そのファイルがテーマのアセットとして使えるようになる。
3. 会員証セクションの「ロゴアセットファイル名」に、そのファイル名（例: `ciara-logo-white.png`）を指定する。

---

### 方法B: 既存のアカウントセクションに埋め込む

アカウント用セクション（例: `sections/account-main.liquid` など）のブロック一覧の前に、下記「スニペット用 HTML + CSS + script」を配置する。

---

## 3. セクション用 Liquid（sections/member-card.liquid）

```liquid
{% comment %}
  会員番号: メタフィールド membership.id があればそれを使用、なければ customer.id を表示用に使用
{% endcomment %}
{% assign member_id = customer.metafields.membership.id.value | default: customer.id | append: '' %}
{% assign rank_name = customer.metafields.vip.rank_name.value | default: '' %}
{% assign rank_class = '' %}
{% if rank_name contains 'ダイヤモンド' %}{% assign rank_class = 'plastic-card--diamond' %}
{% elsif rank_name contains 'プラチナ' %}{% assign rank_class = 'plastic-card--platinum' %}
{% elsif rank_name contains 'ゴールド' %}{% assign rank_class = 'plastic-card--gold' %}
{% elsif rank_name contains 'シルバー' %}{% assign rank_class = 'plastic-card--silver' %}
{% elsif rank_name contains 'レギュラー' or rank_name contains '白' %}{% assign rank_class = 'plastic-card--regular' %}
{% endif %}

{% comment %} ロゴはテーマ assets から読み、同一オリジンにすることで mask-image が効き、白い部分だけにランク色がのる。section がない（テンプレート直書き）でも動くようにフォールバックあり {% endcomment %}
{% assign logo_asset = 'ciara-logo.svg' %}
{% if section.settings.logo_asset != blank %}{% assign logo_asset = section.settings.logo_asset | strip %}{% endif %}
{% assign logo_src = logo_asset | asset_url %}
{% assign logo_for_css = logo_src | replace: "'", "%27" %}

<div class="member-card-section" style="max-width: 360px; margin: 0 auto 24px;">
  <div class="plastic-card plastic-card--account {{ rank_class }}">
    <div class="plastic-card-top">
      <div class="plastic-card-logo-wrap" style="--logo-url: url('{{ logo_for_css }}');">
        <img
          class="plastic-card-logo"
          src="{{ logo_src }}"
          alt=""
          width="120"
          height="48"
          loading="lazy"
        >
      </div>
    </div>
    <div class="plastic-card-bottom">
      <div class="barcode-id-block">
        <div class="barcode-wrap">
          <svg id="customer-barcode" class="customer-barcode-svg"></svg>
        </div>
        <div class="member-id-on-card">{{ member_id }}</div>
      </div>
      <div class="card-bottom-spacer"></div>
    </div>
  </div>
  <p class="hint-below-card">お会計の際にこの画面のバーコードを提示してください。</p>
  <div class="section-bordered">会員ID：{{ member_id }}</div>
</div>

<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"></script>
<script>
  (function() {
    var memberId = {{ member_id | json }};
    var el = document.getElementById("customer-barcode");
    if (el && memberId) {
      try {
        JsBarcode(el, String(memberId).trim(), {
          format: "CODE128",
          displayValue: false,
          width: 2,
          height: 45
        });
      } catch (e) {
        console.error("JsBarcode error:", e);
      }
    }
  })();
</script>

<style>
  .member-card-section .plastic-card--account {
    width: 100%;
    max-width: 100%;
    margin: 0 auto 16px;
    aspect-ratio: 1.586;
    background: #e3c8aa;
    border-radius: 16px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.12);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .member-card-section .plastic-card-top {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px 24px;
    min-height: 0;
  }
  .member-card-section .plastic-card-logo-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    max-width: 120px;
    max-height: 48px;
  }
  .member-card-section .plastic-card-logo {
    max-width: 120px;
    max-height: 48px;
    width: auto;
    height: auto;
    object-fit: contain;
    position: relative;
    z-index: 0;
  }
  .member-card-section .plastic-card-logo-wrap::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 1;
    mask-image: var(--logo-url);
    mask-size: contain;
    mask-repeat: no-repeat;
    mask-position: center;
    -webkit-mask-image: var(--logo-url);
    -webkit-mask-size: contain;
    -webkit-mask-repeat: no-repeat;
    -webkit-mask-position: center;
    mix-blend-mode: screen;
    pointer-events: none;
  }
  .member-card-section .plastic-card--diamond .plastic-card-logo-wrap::after { background: rgba(185, 242, 255, 0.7); }
  .member-card-section .plastic-card--platinum .plastic-card-logo-wrap::after { background: rgba(229, 228, 245, 0.7); }
  .member-card-section .plastic-card--gold .plastic-card-logo-wrap::after { background: rgba(255, 215, 0, 0.55); }
  .member-card-section .plastic-card--silver .plastic-card-logo-wrap::after { background: rgba(192, 192, 192, 0.6); }
  .member-card-section .plastic-card--regular .plastic-card-logo-wrap::after { background: rgba(255, 255, 255, 0.4); }
  .member-card-section .plastic-card-bottom {
    padding: 0 16px 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: flex-end;
  }
  .member-card-section .barcode-id-block {
    background: #fff;
    border-radius: 0;
    padding: 10px 10px 8px;
    margin: 0;
  }
  .member-card-section .barcode-wrap {
    display: flex;
    justify-content: center;
    align-items: center;
    width: 100%;
    margin: 0;
  }
  .member-card-section .customer-barcode-svg {
    width: 100%;
    height: 80px;
    max-width: 100%;
  }
  .member-card-section .member-id-on-card {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: #202223;
    text-align: center;
  }
  .member-card-section .card-bottom-spacer {
    height: 14px;
    background: #e3c8aa;
    margin: 0 -1px 0 0;
  }
  .member-card-section .hint-below-card {
    font-size: 13px;
    color: #6d7175;
    text-align: center;
    margin: 0 0 20px;
    line-height: 1.6;
  }
  .member-card-section .section-bordered {
    border-top: 1px solid #e1e3e5;
    border-bottom: 1px solid #e1e3e5;
    padding: 14px 0;
    margin-bottom: 16px;
    font-size: 14px;
    color: #202223;
    text-align: center;
  }
</style>

{% schema %}
{
  "name": "会員証カード",
  "tag": "section",
  "class": "section-member-card",
  "settings": [
    {
      "type": "text",
      "id": "logo_asset",
      "label": "ロゴアセットファイル名",
      "default": "ciara-logo-white.png",
      "info": "テーマの assets に置いた白ロゴのファイル名。同一オリジンにすることでロゴの白い部分だけにランク色がのります。"
    }
  ],
  "presets": [
    {
      "name": "会員証カード"
    }
  ]
}
{% endschema %}
```

- 会員番号は `customer.metafields.membership.id.value` を優先し、無い場合は `customer.id` を文字列で表示しています。LIFFと揃えるなら、ストアで `membership.id` を設定してください。
- ロゴは**テーマの assets** に置いたファイルを `asset_url` で読みます。セクション設定「ロゴアセットファイル名」（既定: `ciara-logo-white.png`）で指定。同一オリジンになるため `mask-image` が効き、**ロゴの白い部分だけ**にランク色がのります。
- バーコードは「生成高さ45px・表示領域80px」で、LIFF会員証と同じ見た目にしています。

## 4. 既存ブロックの置き換えだけしたい場合

すでに `<svg id="customer-barcode">` と `<p class="customer-id">` がある場合は、その部分だけ次のように差し替えます。

1. **HTML**  
   - 会員証と同じ「カード＋barcode-id-block＋会員ID＋余白」のブロックで囲む。
2. **CSS**  
   - 上記 `<style>` 内の `.member-card-section` を、実際の親クラス（例: `.account__block-item`）に合わせて付け替える。
3. **スクリプト**  
   - `member_id` を `{{ customer.metafields.membership.id.value | default: customer.id }}` などで渡し、`JsBarcode(..., { format: "CODE128", displayValue: false, width: 2, height: 45 })` のままにすると、LIFFと同じバーコードになります。

これで「サイトのアカウント」の該当箇所を、会員証と同じカードデザインにできます。

## 5. インライン SVG でロゴを直接書く方法（アセットが読めない場合）

**直接 SVG を埋め込んでも問題ありません。** アセットの読み込みに失敗する環境では、こちらの方が確実です。

**やり方**: `<img>` と `--logo-url` の代わりに、ロゴの SVG コードをそのまま HTML に書きます。ランク色は **SVG の `fill` を CSS で上書き**するだけで付けられます（`::after` のマスクは不要です）。

1. **表示部分の差し替え**  
   次の部分を削除し:
   ```liquid
   <div class="plastic-card-logo-wrap" style="--logo-url: url('{{ logo_for_css }}');">
     <img class="plastic-card-logo" src="{{ logo_src }}" alt="" width="120" height="48" loading="lazy" />
   </div>
   ```
   代わりに、同じラップだけ残して中身をインライン SVG にします:
   ```liquid
   <div class="plastic-card-logo-wrap plastic-card-logo-wrap--inline">
     <svg class="plastic-card-logo plastic-card-logo--svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1217.51 450" width="120" height="45" style="display:block;max-width:100%;height:auto;"><defs><style>.cls-1{fill:#fff;}</style></defs><path class="cls-1" d="M418.92,444.15v-4.68l6.56-1.87c6.24-1.87,10.54-4.69,12.88-8.43,2.34-3.75,3.51-8.74,3.51-14.99v-146.63c0-6.56-1.17-11.48-3.51-14.76-2.34-3.28-6.64-5.54-12.88-6.79l-6.56-1.41v-4.68l85.73-27.64,4.68,4.68-1.41,66.52v131.17c0,6.25,1.17,11.24,3.51,14.99,2.34,3.75,6.48,6.56,12.41,8.43l4.68,1.41v4.68h-109.62Z"/><path class="cls-1" d="M807.28,444.15v-4.69l6.56-1.87c6.24-1.87,10.54-4.69,12.88-8.43,2.34-3.75,3.51-8.74,3.51-14.99v-146.63c0-6.56-1.17-11.48-3.51-14.76-2.34-3.28-6.64-5.54-12.88-6.79l-6.56-1.41v-4.68l85.73-27.64,4.68,4.68-1.41,66.52v131.17c0,6.25,1.17,11.24,3.51,14.99,2.34,3.75,6.48,6.56,12.41,8.43l4.68,1.41v4.69h-109.62Z"/><path class="cls-1" d="M944.82,281.56c-7.93,0-14.63-2.65-20.1-7.96-5.48-5.31-8.21-12.03-8.21-20.18s2.74-15.18,8.21-20.36c5.47-5.18,12.17-7.78,20.1-7.78s14.56,2.59,19.92,7.78c5.36,5.18,8.04,11.98,8.04,20.36s-2.68,14.87-8.04,20.18c-5.36,5.31-12.01,7.96-19.92,7.96Z"/><path class="cls-1" d="M473.91,185.27c-7.92,0-14.63-2.65-20.1-7.96-5.48-5.31-8.21-12.03-8.21-20.18s2.74-15.18,8.21-20.36c5.47-5.18,12.17-7.77,20.1-7.77s14.56,2.59,19.92,7.77c5.36,5.18,8.04,11.98,8.04,20.36,0,8.15-2.68,14.87-8.04,20.18-5.36,5.31-12.01,7.96-19.92,7.96Z"/><path class="cls-1" d="M1213.29,416.05h-10.31c-13.12,0-19.68-7.03-19.68-21.08v-103.53c0-30.6-7.58-52.7-22.72-66.29-15.15-13.59-36.62-20.38-64.41-20.38-17.18,0-33.11,2.19-47.78,6.56-14.68,4.38-26.47,10.94-35.37,19.68-1.65,1.62-3.09,3.33-4.43,5.09,0,0-.46.77-.49.81-3.06,4.48-4.59,9.86-4.59,16.13,0,8.15,2.74,14.87,8.21,20.18,5.47,5.31,12.17,7.96,20.1,7.96s14.56-2.65,19.93-7.96c4.51-4.47,7.1-9.96,7.81-16.45.18-2.62.02-4.05.05-7.19.02-2.54.07-4.96.07-6.51,0-16.33,13.17-29.57,29.41-29.57s29.42,13.24,29.42,29.57c0,8.71.14,66.17.14,66.17-6.87,1.25-13.43,2.42-19.68,3.51-6.25,1.1-11.87,2.11-16.86,3.05-32.17,6.25-55.75,15.54-70.74,27.87-14.99,12.34-22.49,25.85-22.49,40.52,0,19.37,6.16,34.2,18.5,44.5,12.33,10.31,27.56,15.46,45.68,15.46,15.61,0,28.34-3.51,38.18-10.54,9.84-7.03,19.44-15.53,28.81-25.53,2.5,10.62,7.73,19.13,15.69,25.53,7.96,6.4,18.81,9.6,32.56,9.6,12.8,0,22.72-2.03,29.75-6.09,7.03-4.06,13.5-9.84,19.44-17.33l-4.22-3.75ZM1118.66,397.31c-7.49,6.25-13.98,10.85-19.44,13.82-5.47,2.97-11.32,4.45-17.57,4.45-8.43,0-15.62-3.2-21.55-9.6-5.94-6.4-8.9-16-8.9-28.81,0-14.99,4.29-26.94,12.88-35.84,8.59-8.9,20.06-15.23,34.43-18.97,4.33-.99,7.65-1.69,10.74-2.17,3.15-.49,6.31-1.09,9.4-1.58v78.7Z"/><path class="cls-1" d="M781.86,416.05h-10.31c-13.12,0-19.68-7.03-19.68-21.08v-103.53c0-30.6-7.58-52.7-22.72-66.29-15.15-13.59-36.62-20.38-64.41-20.38-17.18,0-33.11,2.19-47.78,6.56-14.68,4.38-26.47,10.94-35.37,19.68-1.65,1.62-3.09,3.33-4.43,5.09,0,0-.46.77-.49.81-3.06,4.48-4.59,9.86-4.59,16.13,0,8.15,2.74,14.87,8.21,20.18,5.47,5.31,12.17,7.96,20.1,7.96s14.56-2.65,19.93-7.96c4.51-4.47,7.1-9.96,7.81-16.45.18-2.62.02-4.05.05-7.19.02-2.54.07-4.96.07-6.51,0-16.33,13.17-29.57,29.41-29.57s29.42,13.24,29.42,29.57c0,8.71.14,66.17.14,66.17-6.87,1.25-13.43,2.42-19.68,3.51-6.25,1.1-11.87,2.11-16.86,3.05-32.17,6.25-55.75,15.54-70.74,27.87-14.99,12.34-22.49,25.85-22.49,40.52,0,19.37,6.16,34.2,18.5,44.5,12.33,10.31,27.56,15.46,45.67,15.46,15.61,0,28.34-3.51,38.18-10.54,9.84-7.03,19.44-15.53,28.81-25.53,2.5,10.62,7.73,19.13,15.69,25.53,7.96,6.4,18.81,9.6,32.56,9.6,12.8,0,22.72-2.03,29.75-6.09,7.03-4.06,13.5-9.84,19.44-17.33l-4.22-3.75ZM687.23,397.31c-7.5,6.25-13.98,10.85-19.44,13.82-5.47,2.97-11.32,4.45-17.57,4.45-8.43,0-15.62-3.2-21.55-9.6-5.94-6.4-8.9-16-8.9-28.81,0-14.99,4.29-26.94,12.88-35.84,8.59-8.9,20.06-15.22,34.43-18.97,4.33-.99,7.65-1.69,10.74-2.17,3.15-.49,6.31-1.08,9.4-1.58v78.7Z"/><path class="cls-1" d="M249.83,426.26c-1.18,0-2.34-.08-3.51-.11-.12,0-.23,0-.35,0-1.52,0-3.02-.07-4.53-.14l-.82-.04c-2.49-.1-6.28-.47-6.31-.47-32.35-3.27-61.79-20.18-85.24-46.21-34.36-36.92-56.22-92.33-56.22-154.3,0-55.86,17.76-106.39,46.43-142.86,24.9-32.73,57.4-53.01,92.27-57.39.56-.07,1.13-.12,1.7-.17l1.07-.1c4.33-.44,8.14-.65,11.65-.65.18,0,.36.01.54.02,1.11-.03,2.21-.11,3.33-.11,50.19,0,94.84,30.23,123.58,77.22h4.1v-52.5s-2.81-2.15-2.81-2.15c-20.36-15.57-42.85-27.32-66.84-34.92C271.6-.08,233.28-2.99,194.73,3.13c-15.37,2.3-30.57,6.2-45.14,11.58-.35.13-.71.24-1.06.36-.48.16-.96.32-1.44.5-1.4.52-2.76,1.07-4.12,1.63l-1.94.78c-29.76,11.86-55.24,28.15-75.71,48.44-21.95,21.76-38.56,46.38-49.36,73.18C5.17,166.39-.2,194.84,0,224.17c.2,29.34,5.97,57.88,17.15,84.82,11.18,26.97,28.28,51.88,50.81,74.01,11.42,11.22,24.6,21.44,39.07,30.29,27.91,18.47,59.52,30.05,93.89,34.39,10.38,1.54,20.54,2.32,30.21,2.32,25.21,0,50.07-4.56,73.89-13.57,23.68-8.96,47.13-22.34,69.7-39.77l2.79-2.15v-45.81s-3.89,0-3.89,0c-28.73,47.18-73.48,77.56-123.78,77.56Z"/></svg>
   </div>
   ```
   （SVG は1行にまとめて書いても、改行を入れても構いません。クラス `cls-1` がロゴの白い部分です。）

2. **インライン SVG のときは ::after を非表示にし、ランク色は .cls-1 の fill で**  
   インライン SVG を使う場合は `::after` のマスクを使わないため、**`::after` を消さないとロゴの上に半透明の層が重なってロゴが見えなくなります。** 次の CSS を追加・適用してください。
   ```css
   /* インライン SVG のときは ::after を出さない */
   .member-card-section .plastic-card-logo-wrap--inline::after { display: none; }
   /* インライン SVG が潰れないようにサイズを確保 */
   .member-card-section .plastic-card-logo-wrap--inline svg { display: block; width: 120px; height: 45px; max-width: 100%; min-height: 1px; flex-shrink: 0; }
   .member-card-section .plastic-card-logo-wrap--inline .cls-1 { fill: #fff; }
   .member-card-section .plastic-card--diamond .plastic-card-logo-wrap--inline .cls-1 { fill: #b9f2ff; }
   .member-card-section .plastic-card--platinum .plastic-card-logo-wrap--inline .cls-1 { fill: #e5e4f5; }
   .member-card-section .plastic-card--gold .plastic-card-logo-wrap--inline .cls-1 { fill: #ffd700; }
   .member-card-section .plastic-card--silver .plastic-card-logo-wrap--inline .cls-1 { fill: #c0c0c0; }
   .member-card-section .plastic-card--regular .plastic-card-logo-wrap--inline .cls-1 { fill: #fff; }
   ```
   これでランクに応じてロゴの色だけが変わります。

**まとめ**: 直接 SVG を打ち込む方法で表示できているなら、そのままインライン SVG で運用して問題ありません。アセット読み込みに依存しないので、表示もランク色も安定します。

---

## 6. ロゴが表示されないとき（アセットを使う場合）

- **テンプレートやスニペットに直接貼っている場合**: `section.settings` が使えないため、ロゴ用の変数が空になることがあります。Liquid を「`section` がなくてもフォールバックする」形に変更してください（下記の3行に差し替え）。
- **アセットのファイル名**: テーマの **アセット** 一覧に表示されている名前と、**完全に同じ**（拡張子・スペースなし）で指定してください。
- **デバッグ**: 一時的に `<p style="font-size:10px;word-break:break-all;">{{ logo_src }}</p>` をカードの下に追加し、表示された URL をブラウザの新しいタブで開いて、SVG が表示されるか確認してください。404 の場合はアセットにファイルが無いか、ファイル名が違います。

## 7. ロゴに色がつかないとき（マスクが効かない）

1. **レイヤー順**  
   色の層（`::after`）がロゴの**上**にないと `mix-blend-mode: screen` が効きません。  
   - `.plastic-card-logo` は `z-index: 0`  
   - `.plastic-card-logo-wrap::after` は `z-index: 1`  
   になっているか確認してください（上記コードではこの指定にしてあります）。

2. **ランククラスが付いているか**  
   ブラウザの開発者ツールで、カードの `div`（`<div class="plastic-card plastic-card--account ...">`）を検査し、`plastic-card--diamond` や `plastic-card--gold` などが付いているか確認してください。  
   - 付いていない場合: `vip.rank_name` の値が「ダイヤモンド」「ゴールド」などの文字列と一致しているか確認する。  
   - 一時的に `会員ランク：{{ rank_name }}` を表示して、実際の値を確認するとよいです。

3. **ロゴの白い部分だけに色をのせるには**  
   上記「セクション用 Liquid」では、ロゴを**テーマの assets** から `asset_url` で読むようにしてあります。同一オリジンになるため `mask-image` が有効になり、外側に色は出ず**白い部分だけ**にランク色がのります。  
   白ロゴ（透過 PNG）を assets に追加し、セクション設定「ロゴアセットファイル名」にそのファイル名を指定してください。
