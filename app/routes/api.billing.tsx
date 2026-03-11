/**
 * GET  /api/billing        → 現在のプラン状態を返す
 * POST /api/billing        → Shopify App サブスクリプション URL を発行して返す
 *
 * 要件書 §3 / §Epic G: プラン制御
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { isInhouseMode, planLabel, BILLING_PLANS } from "../utils/planFeatures.server";

const APP_SUBSCRIPTION_QUERY = `#graphql
  query CurrentSubscription {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        currentPeriodEnd
        trialDays
      }
    }
  }
`;

const APP_SUBSCRIPTION_CREATE = `#graphql
  mutation AppSubscriptionCreate(
    $name: String!
    $returnUrl: String!
    $lineItems: [AppSubscriptionLineItemInput!]!
    $test: Boolean
  ) {
    appSubscriptionCreate(name: $name, returnUrl: $returnUrl, lineItems: $lineItems, test: $test) {
      userErrors { field message }
      confirmationUrl
      appSubscription { id status }
    }
  }
`;

// ── GET: 現在のプラン情報 ─────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { admin, session } = await authenticate.public(request);
    const shop = await resolveShop(session.shop, admin);

    if (isInhouseMode()) {
      return Response.json({
        planCode: "unlimited",
        planLabel: "自社用（無制限）",
        isInhouse: true,
        activeSubscriptions: [],
      });
    }

    // Shopify のサブスクリプション状態も取得
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

// ── POST: サブスクリプション URL 発行 ─────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const { admin, session } = await authenticate.public(request);
    const shop = await resolveShop(session.shop, admin);

    if (isInhouseMode()) {
      return Response.json({ ok: false, error: "自社用モードでは課金不要です" }, { status: 400 });
    }

    const body = (await request.json()) as { plan?: string; returnUrl?: string };
    const planKey = body.plan === "pro" ? "pro" : "standard";
    const planConfig = BILLING_PLANS[planKey];

    const appUrl = process.env.SHOPIFY_APP_URL ?? "";
    const returnUrl =
      body.returnUrl ?? `${appUrl}/app/settings/billing/callback?plan=${planKey}&shop=${session.shop}`;

    const res = await admin.graphql(APP_SUBSCRIPTION_CREATE, {
      variables: {
        name: planConfig.name,
        returnUrl,
        test: process.env.NODE_ENV !== "production",
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: { amount: planConfig.amount, currencyCode: planConfig.currencyCode },
                interval: "EVERY_30_DAYS",
              },
            },
          },
        ],
      },
    });

    const json = await res.json() as {
      data?: {
        appSubscriptionCreate?: {
          confirmationUrl?: string;
          userErrors?: { field: string; message: string }[];
          appSubscription?: { id: string; status: string };
        };
      };
    };

    const result = json.data?.appSubscriptionCreate;
    const userErrors = result?.userErrors ?? [];
    if (userErrors.length > 0) {
      return Response.json({ ok: false, error: userErrors[0].message }, { status: 400 });
    }

    // DB のプランを仮更新（Webhookで最終同期）
    await prisma.shop.update({
      where: { id: shop.id },
      data: { planCode: planKey },
    });

    return Response.json({
      ok: true,
      confirmationUrl: result?.confirmationUrl,
      planCode: planKey,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
