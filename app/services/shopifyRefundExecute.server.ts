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
        manualPaymentGateway
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
  /** Shopify の OrderTransaction.manualPaymentGateway（手動の決済か） */
  manualPaymentGateway?: boolean | null;
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

/** 決済会社を通す支払い（Shopify Payments など）か。返金するとお客様のカード等へ実際にお金が戻る */
function isProcessorTransaction(tx: OrderTx): boolean {
  const gw = String(tx.gateway ?? "").toLowerCase();
  if (gw.includes("shopify_payments")) return true;
  // 現金は返金してもお金は動かない（店が手で渡す）
  if (gw === "cash") return false;
  return tx.manualPaymentGateway === false;
}

function gatewayMatches(txGateway: string | undefined, method: string): boolean {
  const gw = String(txGateway ?? "").toLowerCase().trim();
  const m = String(method).toLowerCase().trim();
  if (!gw || !m) return false;
  return gw.includes(m) || m.includes(gw);
}

/**
 * 返金先の親取引が決済会社の支払い（Shopify Payments など）なのに、実際は別の手段（現金など）で返したとき、
 * Shopify で返金するとカード等にも戻り、二重に返すことになる。そのときは Shopify では返金せず記録だけにする
 * （T の決定 2026-11-23）。止めるときは理由の文を返す。止めないときは null。
 */
export function processorRefundMismatchReason(
  parents: OrderTx[],
  eventType: string,
  actualRefundMethod?: string | null,
): string | null {
  const actual =
    String(actualRefundMethod ?? "").trim() || (eventType === "cash_refund" ? "cash" : "");
  // 実際の手段が分からないとき（元の支払いへそのまま返す）は今までどおり
  if (!actual) return null;
  const mismatched = parents.find(
    (tx) => isProcessorTransaction(tx) && !gatewayMatches(tx.gateway, actual),
  );
  if (!mismatched) return null;
  return `元の支払い（${String(mismatched.gateway ?? "決済会社")}）は Shopify で返金するとカード等に戻るため、別の手段で返した登録は記録だけにしました（Shopify では返金していません）`;
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

  // 決済会社の支払いを別の手段で返したときは Shopify で返金しない（二重に返さない）
  const mismatchReason = processorRefundMismatchReason(
    parents,
    params.eventType,
    params.actualRefundMethod,
  );
  if (mismatchReason) {
    return { status: "skipped", reason: mismatchReason };
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
