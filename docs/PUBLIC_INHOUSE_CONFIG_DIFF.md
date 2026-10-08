# public / inhouse 設定差分の短い検証メモ

方針変更なし。現行 toml・Render・deploy script の差分確認と、Phase 2 の取り違え防止ガード。

| 項目 | public | inhouse |
|------|--------|---------|
| Shopify config | `shopify.app.public.toml` | `shopify.app.toml` |
| アプリ名 / URL | POS Receipt / `pos-receipt.onrender.com` | POS Receipt - Ciara / `pos-receipt-ciara.onrender.com` |
| client_id | 公開用（別アプリ） | 自社用（別アプリ） |
| scopes | orders/locations/gift_cards/products + draft/orders write | 上記 + `read_customers` / `write_customers` / `write_app_proxy` |
| app_proxy | なし | `/apps/member-card`（会員証） |
| Render service | `pos-receipt`（`render.yaml`） | `pos-receipt-ciara` + `APP_DISTRIBUTION=inhouse` |
| Shopify deploy | `npm run deploy:public`（`APP_MODE=public` + verify） | `npm run deploy:inhouse`（`APP_MODE=inhouse` + verify） |
| プラン | Billing Lite/Pro | 全機能解放（会員証含む） |
| 起動ガード | typo 拒否・公開ホストで inhouse 禁止 | typo 拒否・ciara ホストでは inhouse 必須 |

検証観点（コード上）:

1. **拡張の接続先**はビルド時 `extensions/common/appUrl.js` の `APP_MODE` で決まる。deploy script が toml 切替と同時に書き換え・`verify-app-mode` する。
2. **精算・特殊返金・領収書の集計経路**は distribution 分岐なし（同一エンジン）。会員証・Billing ゲートのみ差分。
3. **サーバー起動**は `scripts/lib/deployGuard.mjs` で APP_DISTRIBUTION / 既知ホストを検証（`SKIP_DISTRIBUTION_GUARD=1` は緊急時のみ）。
4. **CI** は public/inhouse を別ジョブに分けず、純関数テスト + 単一 `npm run build`。

詳細手順の正本: [DEPLOY_PUBLIC_AND_INHOUSE.md](./DEPLOY_PUBLIC_AND_INHOUSE.md)。
