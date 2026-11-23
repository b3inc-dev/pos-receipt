/**
 * GET /api/orders/:orderId/redo-cart
 * キャンセル・返金済み注文から、POS のカートに入れる中身（会計やり直し）を返す。
 * カートへの追加は POS 拡張が Cart API で行う。ここでは Shopify に何も書かない（読み取りのみ）。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  authenticatePosRequestOrCorsError,
  corsErrorJson,
  corsPreflightResponse,
} from "../utils/posAuth.server";
import {
  getAppSetting,
  SPECIAL_REFUND_SETTINGS_KEY,
  DEFAULT_SPECIAL_REFUND_SETTINGS,
  type SpecialRefundSettings,
} from "../utils/appSettings.server";
import { adminGraphqlWithRetry } from "../lib/shopifyGraphqlThrottle.server";
import { isOrderEligibleForRedoDraft } from "../services/orderRedoDraft.server";
import {
  buildRedoCartPlan,
  resolveOrderRedoOptions,
  type RedoCartSourceOrder,
} from "../services/orderRedoCartPlan";

const REDO_CART_ORDER_QUERY = `#graphql
  query RedoCartOrder($id: ID!) {
    order(id: $id) {
      id
      name
      currencyCode
      cancelledAt
      displayFinancialStatus
      refunds { id }
      customer { id }
      lineItems(first: 100) {
        nodes {
          title
          name
          quantity
          taxable
          variant { id price }
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          discountAllocations {
            allocatedAmountSet { shopMoney { amount currencyCode } }
            discountApplication {
              __typename
              ... on DiscountCodeApplication { code }
              ... on ManualDiscountApplication { title }
              ... on AutomaticDiscountApplication { title }
              ... on ScriptDiscountApplication { title }
            }
          }
        }
      }
    }
  }
`;

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;

    const orderId = params.orderId;
    if (!orderId) {
      return corsJson({ ok: false, error: "orderId required" }, { status: 400 });
    }
    const gid = orderId.startsWith("gid://")
      ? orderId
      : `gid://shopify/Order/${orderId.replace(/\D/g, "")}`;

    const settingsRaw = await getAppSetting<Partial<SpecialRefundSettings>>(
      shop.id,
      SPECIAL_REFUND_SETTINGS_KEY,
    );
    const settings = { ...DEFAULT_SPECIAL_REFUND_SETTINGS, ...settingsRaw };

    const res = await adminGraphqlWithRetry(admin, REDO_CART_ORDER_QUERY, {
      variables: { id: gid },
    });
    const json = (await res.json()) as {
      data?: { order?: (RedoCartSourceOrder & Record<string, unknown>) | null };
      errors?: { message?: string }[];
    };
    if (json.errors?.length) {
      return corsJson({ ok: false, error: "注文を読み込めませんでした" }, { status: 500 });
    }
    const order = json.data?.order;
    if (!order) {
      return corsJson({ ok: false, error: "元の注文が見つかりません" }, { status: 404 });
    }

    const eligible = isOrderEligibleForRedoDraft(
      order as Parameters<typeof isOrderEligibleForRedoDraft>[0],
    );
    const { canRedoToCart } = resolveOrderRedoOptions(settings, eligible);
    if (!canRedoToCart) {
      return corsJson(
        {
          ok: false,
          error: eligible
            ? "カートに入れる会計やり直しは、設定で使わないことになっています"
            : "キャンセル・返金済みの注文だけ、会計をやり直せます",
        },
        { status: 403 },
      );
    }

    const plan = buildRedoCartPlan(order);
    if (plan.lines.length === 0) {
      return corsJson({ ok: false, error: "カートに入れられる商品がありません" }, { status: 400 });
    }
    return corsJson({ ok: true, plan });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
