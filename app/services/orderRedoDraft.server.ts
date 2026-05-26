/**
 * キャンセル・返金済み注文を元に、会計やり直し用の下書き注文を作成する
 */
import { adminGraphqlWithRetry } from "../lib/shopifyGraphqlThrottle.server";
import { ORDER_DETAIL_QUERY } from "./orderDetail.server";

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

const DRAFT_ORDER_CREATE = `#graphql
  mutation RedoDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        status
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type MoneyBag = { shopMoney?: { amount?: string; currencyCode?: string } };

function moneyAmount(m?: MoneyBag | null): string {
  return m?.shopMoney?.amount ?? "0";
}

function orderGid(sourceOrderId: string): string {
  const s = String(sourceOrderId).trim();
  if (s.startsWith("gid://")) return s;
  const num = s.replace(/\D/g, "");
  return `gid://shopify/Order/${num}`;
}

/** 会計やり直し（下書き作成）の対象か */
export function isOrderEligibleForRedoDraft(order: {
  cancelledAt?: string | null;
  displayFinancialStatus?: string | null;
  refunds?: unknown[] | null;
}): boolean {
  if (order.cancelledAt) return true;
  const fs = String(order.displayFinancialStatus ?? "").toUpperCase();
  if (
    fs.includes("REFUND") ||
    fs === "VOIDED" ||
    fs === "PARTIALLY_REFUNDED" ||
    fs === "REFUNDED"
  ) {
    return true;
  }
  const refunds = order.refunds;
  if (Array.isArray(refunds) && refunds.length > 0) return true;
  return false;
}

type DraftLineInput = Record<string, unknown>;

function buildDraftLineItems(
  lineNodes: Record<string, unknown>[],
): { lineItems: DraftLineInput[]; skippedCount: number } {
  const lineItems: DraftLineInput[] = [];
  let skippedCount = 0;

  for (const li of lineNodes) {
    const qty = Math.max(0, Math.floor(Number(li.quantity ?? 0)));
    if (qty <= 0) {
      skippedCount += 1;
      continue;
    }

    const unitPrice = moneyAmount(li.discountedUnitPriceSet as MoneyBag)
      || moneyAmount(li.originalUnitPriceSet as MoneyBag);
    const price = Number(unitPrice);
    const originalUnitPrice =
      Number.isFinite(price) && price >= 0 ? price.toFixed(2) : "0.00";

    const variant = li.variant as { id?: string } | null | undefined;
    const variantId = variant?.id ? String(variant.id) : "";

    if (variantId) {
      lineItems.push({
        variantId,
        quantity: qty,
        originalUnitPrice,
      });
      continue;
    }

    const title = String(li.title ?? li.name ?? "商品").trim() || "商品";
    const sku = li.sku ? String(li.sku) : undefined;
    lineItems.push({
      title,
      quantity: qty,
      originalUnitPrice,
      ...(sku ? { sku } : {}),
      requiresShipping: false,
    });
  }

  return { lineItems, skippedCount };
}

export type CreateRedoDraftResult =
  | {
      ok: true;
      draftOrder: {
        id: string;
        name: string;
        status: string;
        totalAmount: string;
        currencyCode: string;
        lineItemCount: number;
      };
      sourceOrder: { id: string; name: string };
      skippedLineCount: number;
    }
  | { ok: false; error: string };

/**
 * 元注文の内容をコピーした下書き注文を作成（確定・決済は行わない）
 */
export async function createRedoDraftFromOrder(
  admin: AdminClient,
  sourceOrderId: string,
): Promise<CreateRedoDraftResult> {
  const gid = orderGid(sourceOrderId);

  const res = await adminGraphqlWithRetry(admin, ORDER_DETAIL_QUERY, {
    variables: { id: gid },
  });
  const json = (await res.json()) as {
    data?: { order?: Record<string, unknown> };
    errors?: { message?: string }[];
  };

  if (json.errors?.length) {
    return { ok: false, error: json.errors.map((e) => e.message).join("; ") };
  }

  const order = json.data?.order;
  if (!order?.id) {
    return { ok: false, error: "元の注文が見つかりません" };
  }

  if (!isOrderEligibleForRedoDraft(order as Parameters<typeof isOrderEligibleForRedoDraft>[0])) {
    return {
      ok: false,
      error:
        "この注文はキャンセル・返金済みではないため、会計やり直し用の下書きは作成できません",
    };
  }

  const lineNodes =
    (order.lineItems as { nodes?: Record<string, unknown>[] })?.nodes ?? [];
  const { lineItems, skippedCount } = buildDraftLineItems(lineNodes);

  if (lineItems.length === 0) {
    return { ok: false, error: "下書きにコピーできる商品がありません" };
  }

  const orderName = String(order.name ?? "");
  const customer = order.customer as { id?: string; email?: string } | null;
  const loc = order.retailLocation as { id?: string; name?: string } | null;

  const noteLines = [
    ...(loc?.name ? [`ロケーション: ${loc.name}`] : []),
    `会計やり直し用下書き（元注文: ${orderName}）`,
    "POS Receipt から作成。決済は POS または管理画面で行ってください。",
    order.note ? `元メモ: ${String(order.note).slice(0, 200)}` : "",
  ].filter(Boolean);

  const sourceTag = orderName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);

  const draftRes = await adminGraphqlWithRetry(admin, DRAFT_ORDER_CREATE, {
    variables: {
      input: {
        note: noteLines.join("\n").slice(0, 5000),
        tags: ["pos-receipt-redo", `redo-from-${sourceTag}`],
        ...(customer?.id ? { customerId: customer.id } : {}),
        ...(customer?.email ? { email: customer.email } : {}),
        lineItems,
        useCustomerDefaultAddress: Boolean(customer?.id),
      },
    },
  });

  const draftJson = (await draftRes.json()) as {
    data?: {
      draftOrderCreate?: {
        draftOrder?: {
          id?: string;
          name?: string;
          status?: string;
          totalPriceSet?: MoneyBag;
        };
        userErrors?: { message: string }[];
      };
    };
    errors?: { message?: string }[];
  };

  if (draftJson.errors?.length) {
    return { ok: false, error: draftJson.errors.map((e) => e.message).join("; ") };
  }

  const payload = draftJson.data?.draftOrderCreate;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length > 0) {
    return { ok: false, error: userErrors.map((e) => e.message).join("; ") };
  }

  const draft = payload?.draftOrder;
  if (!draft?.id) {
    return { ok: false, error: "下書き注文の作成に失敗しました" };
  }

  return {
    ok: true,
    draftOrder: {
      id: draft.id,
      name: String(draft.name ?? ""),
      status: String(draft.status ?? "OPEN"),
      totalAmount: moneyAmount(draft.totalPriceSet),
      currencyCode: draft.totalPriceSet?.shopMoney?.currencyCode ?? "JPY",
      lineItemCount: lineItems.length,
    },
    sourceOrder: {
      id: String(order.id),
      name: orderName,
    },
    skippedLineCount: skippedCount,
  };
}
