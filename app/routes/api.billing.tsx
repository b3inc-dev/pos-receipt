/**
 * GET /api/billing → 現在のプラン状態（管理画面から呼ぶ場合用）
 * 2026-11-21: 公開用の料金は Shopify App Pricing。アプリは契約を作らない（プランの選択は Shopify の料金プラン画面）。
 * プランは shopPlan.server.ts が Shopify の契約から読む。
 *
 * 要件書 §3 / §Epic G: プラン制御
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { isInhouseMode, planLabel } from "../utils/planFeatures.server";
import { getShopPlan } from "../utils/shopPlan.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { admin, session } = await authenticate.admin(request);
    const shop = await resolveShop(session.shop, admin);
    const state = await getShopPlan(admin, shop);

    if (state.fullAccess) {
      return Response.json({
        planCode: "unlimited",
        planLabel: isInhouseMode() ? "自社用（無制限）" : "全機能利用可能",
        isInhouse: true,
        activeSubscriptions: [],
      });
    }

    return Response.json({
      planCode: state.planCode,
      planLabel: planLabel(state.planCode),
      isInhouse: false,
      subscriptionsRead: state.subscriptionsRead,
      activeSubscriptions: state.activeSubscriptions.map(({ id, name, status }) => ({ id, name, status })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
