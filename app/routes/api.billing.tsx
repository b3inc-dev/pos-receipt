/**
 * GET /api/billing → 現在のプラン状態（管理画面から呼ぶ場合用）
 * ※ サブスクリプション作成は app.plan.tsx の action で行う
 *
 * 要件書 §3 / §Epic G: プラン制御
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getFullAccess, isInhouseMode, planLabel } from "../utils/planFeatures.server";

const APP_SUBSCRIPTION_QUERY = `#graphql
  query CurrentSubscription {
    currentAppInstallation {
      activeSubscriptions {
        id name status currentPeriodEnd trialDays
      }
    }
  }
`;

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { admin, session } = await authenticate.admin(request);
    const shop = await resolveShop(session.shop, admin);

    const fullAccess = await getFullAccess(admin, session);
    if (fullAccess) {
      return Response.json({
        planCode: "unlimited",
        planLabel: isInhouseMode() ? "自社用（無制限）" : "全機能利用可能",
        isInhouse: true,
        activeSubscriptions: [],
      });
    }

    let activeSubscriptions: { id: string; name: string; status: string }[] = [];
    try {
      const res = await admin.graphql(APP_SUBSCRIPTION_QUERY);
      const json = await res.json() as {
        data?: {
          currentAppInstallation?: {
            activeSubscriptions?: { id: string; name: string; status: string; currentPeriodEnd: string }[];
          };
        };
      };
      activeSubscriptions = json.data?.currentAppInstallation?.activeSubscriptions ?? [];
    } catch {}

    return Response.json({
      planCode: shop.planCode ?? "standard",
      planLabel: planLabel(shop.planCode),
      isInhouse: false,
      activeSubscriptions,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
