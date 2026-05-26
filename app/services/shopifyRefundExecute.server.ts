/**
 * Shopify Admin API での実返金（refundCreate）
 * 特殊返金イベント登録後、設定が shopify_execute のときに呼ぶ
 */
import { adminGraphqlWithRetry } from "../lib/shopifyGraphqlThrottle.server";
import type { SpecialRefundSettings } from "../utils/appSettings.server";

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

export type ShopifyRefundExecutionResult =
  | { status: "skipped"; reason: string }
  | { status: "success"; refundId: string }
  | { status: "failed"; error: string };

const ORDER_FOR_REFUND_QUERY = `#graphql
  query OrderForRefund($id: ID!) {
    order(id: $id) {
      id
      name
      refundable
      displayFinancialStatus
      transactions(first: 30) {
        id
        kind
        status
        gateway
        amountSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
    }
  }
`;

const REFUND_CREATE_MUTATION = `#graphql
  mutation RefundCreate($input: RefundInput!) {
    refundCreate(input: $input) {
      refund {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type OrderTx = {
  id: string;
  kind?: string;
  status?: string;
  gateway?: string;
  amountSet?: { shopMoney?: { amount?: string } };
};

function orderGid(sourceOrderId: string): string {
  const s = String(sourceOrderId).trim();
  if (s.startsWith("gid://")) return s;
  const num = s.replace(/\D/g, "");
  return `gid://shopify/Order/${num}`;
}

function isSaleTransaction(tx: OrderTx): boolean {
  const kind = String(tx.kind ?? "").toUpperCase();
  const status = String(tx.status ?? "").toUpperCase();
  if (status !== "SUCCESS") return false;
  return kind === "SALE" || kind === "CAPTURE";
}

/** 設定とイベント種別から Shopify 返金を実行するか */
export function shouldExecuteShopifyRefund(
  settings: SpecialRefundSettings,
  eventType: string,
  adjustKind?: string | null,
): boolean {
  if (settings.refundProcessingMode !== "shopify_execute") {
    return false;
  }
  if (eventType === "voucher_change_adjustment") {
    return false;
  }
  if (eventType === "cash_refund" && settings.shopifyExecuteCashRefund) return true;
  if (eventType === "payment_method_override" && settings.shopifyExecutePaymentMethodOverride) {
    return true;
  }
  if (eventType === "receipt_cash_adjustment" && settings.shopifyExecuteReceiptCashAdjustment) {
    if (adjustKind === "extra") return false;
    return true;
  }
  return false;
}

function pickParentTransactions(transactions: OrderTx[], preferGateway?: string | null): OrderTx[] {
  const sales = transactions.filter(isSaleTransaction);
  if (sales.length === 0) return [];
  if (preferGateway) {
    const gw = String(preferGateway).toLowerCase();
    const matched = sales.filter((t) => String(t.gateway ?? "").toLowerCase().includes(gw));
    if (matched.length > 0) return matched;
  }
  return sales.sort(
    (a, b) =>
      Number(b.amountSet?.shopMoney?.amount ?? 0) - Number(a.amountSet?.shopMoney?.amount ?? 0),
  );
}

function buildRefundTransactions(
  parentTxs: OrderTx[],
  refundAmount: number,
  orderId: string,
): Array<{ orderId: string; parentId: string; amount: string; gateway: string; kind: string }> {
  let remaining = Math.round(refundAmount * 100) / 100;
  const out: Array<{ orderId: string; parentId: string; amount: string; gateway: string; kind: string }> =
    [];

  for (const tx of parentTxs) {
    if (remaining <= 0) break;
    const txAmount = Number(tx.amountSet?.shopMoney?.amount ?? 0);
    if (txAmount <= 0) continue;
    const slice = Math.min(remaining, txAmount);
    out.push({
      orderId,
      parentId: tx.id,
      amount: slice.toFixed(2),
      gateway: String(tx.gateway ?? "manual"),
      kind: "REFUND",
    });
    remaining = Math.round((remaining - slice) * 100) / 100;
  }

  if (remaining > 0.009) {
    throw new Error(`返金可能額を超えています（残り ¥${remaining.toLocaleString()}）`);
  }
  return out;
}

/**
 * Shopify に実返金を作成する
 */
export async function executeShopifyRefundForEvent(
  admin: AdminClient,
  params: {
    sourceOrderId: string;
    amount: number;
    eventType: string;
    note?: string | null;
    originalPaymentMethod?: string | null;
    actualRefundMethod?: string | null;
    adjustKind?: string | null;
  },
): Promise<ShopifyRefundExecutionResult> {
  const orderId = orderGid(params.sourceOrderId);
  const refundAmount = Number(params.amount);
  if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
    return { status: "failed", error: "返金金額が不正です" };
  }

  const res = await adminGraphqlWithRetry(admin, ORDER_FOR_REFUND_QUERY, {
    variables: { id: orderId },
  });
  const json = (await res.json()) as {
    data?: {
      order?: {
        id?: string;
        refundable?: boolean;
        transactions?: OrderTx[];
      };
    };
    errors?: { message?: string }[];
  };

  if (json.errors?.length) {
    return { status: "failed", error: json.errors.map((e) => e.message).join("; ") };
  }

  const order = json.data?.order;
  if (!order?.id) {
    return { status: "failed", error: "注文が見つかりません" };
  }
  if (order.refundable === false) {
    return { status: "failed", error: "この注文は Shopify 上で返金できない状態です" };
  }

  const preferGw =
    params.actualRefundMethod || params.originalPaymentMethod || null;
  const parents = pickParentTransactions(order.transactions ?? [], preferGw);
  if (parents.length === 0) {
    return { status: "failed", error: "返金対象の支払いトランザクションがありません" };
  }

  let refundTxs;
  try {
    refundTxs = buildRefundTransactions(parents, refundAmount, order.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "返金額の配分に失敗しました";
    return { status: "failed", error: msg };
  }

  const noteParts = [
    "POS Receipt 特殊返金",
    params.eventType,
    params.note?.trim() || "",
  ].filter(Boolean);

  const refundRes = await adminGraphqlWithRetry(admin, REFUND_CREATE_MUTATION, {
    variables: {
      input: {
        orderId: order.id,
        notify: false,
        note: noteParts.join(" / ").slice(0, 500),
        transactions: refundTxs,
      },
    },
  });

  const refundJson = (await refundRes.json()) as {
    data?: {
      refundCreate?: {
        refund?: { id?: string };
        userErrors?: { field?: string[]; message: string }[];
      };
    };
    errors?: { message?: string }[];
  };

  if (refundJson.errors?.length) {
    return { status: "failed", error: refundJson.errors.map((e) => e.message).join("; ") };
  }

  const payload = refundJson.data?.refundCreate;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length > 0) {
    return {
      status: "failed",
      error: userErrors.map((e) => e.message).join("; "),
    };
  }

  const refundId = payload?.refund?.id;
  if (!refundId) {
    return { status: "failed", error: "返金IDが取得できませんでした" };
  }

  return { status: "success", refundId };
}
