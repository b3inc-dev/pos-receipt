# public / inhouse 設定差分の短い検証メモ（Phase 1）

方針変更なし。現行 toml・Render・deploy script の差分確認のみ。

| 項目 | public | inhouse |
|------|--------|---------|
| Shopify config | `shopify.app.public.toml` | `shopify.app.toml` |
| アプリ名 / URL | POS Receipt / `pos-receipt.onrender.com` | POS Receipt - Ciara / `pos-receipt-ciara.onrender.com` |
| client_id | 公開用（別アプリ） | 自社用（別アプリ） |
| scopes | orders/locations/gift_cards/products + draft/orders write | 上記 + `read_customers` / `write_customers` / `write_app_proxy` |
| app_proxy | なし | `/apps/member-card`（会員証） |
| Render service | `pos-receipt`（`render.yaml`） | `pos-receipt-ciara` + `APP_DISTRIBUTION=inhouse` |
| Shopify deploy | `npm run deploy:public`（`APP_MODE=public`） | `npm run deploy:inhouse`（`APP_MODE=inhouse`） |
| プラン | Billing Lite/Pro | 全機能解放（会員証含む） |

検証観点（コード上）:

1. **拡張の接続先**はビルド時 `extensions/common/appUrl.js` の `APP_MODE` で決まる。deploy script が toml 切替と同時に書き換えていること。
2. **精算・特殊返金・領収書の集計経路**は distribution 分岐なし（同一エンジン）。会員証・Billing ゲートのみ差分。
3. **CI**（本 PR）は public/inhouse を別ジョブに分けず、純関数テスト + 単一 `npm run build`。設定差分自体の自動検証は含まない。

詳細手順の正本: [DEPLOY_PUBLIC_AND_INHOUSE.md](./DEPLOY_PUBLIC_AND_INHOUSE.md)。
