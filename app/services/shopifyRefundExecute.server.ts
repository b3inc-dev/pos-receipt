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
  | { status: "retryable"; error: string }
  | { status: "failed"; error: string };

const RETRYABLE_REFUND_ERROR_CODES = new Set([
  "IDEMPOTENCY_CONCURRENT_REQUEST",
  "THROTTLED",
  "INTERNAL_SERVER_ERROR",
  "SERVICE_UNAVAILABLE",
]);

export function isRetryableRefundError(
  errors: Array<{ code?: string | null; message?: string | null }>,
): boolean {
  return errors.some((error) => {
    const code = String(error.code ?? "").trim().toUpperCase();
    const message = String(error.message ?? "").toUpperCase();
    return (
      RETRYABLE_REFUND_ERROR_CODES.has(code) ||
      message.includes("IDEMPOTENCY_CONCURRENT_REQUEST") ||
      message.includes("TRY AGAIN") ||
      message.includes("TEMPORAR")
    );
  });
}

const ORDER_FOR_REFUND_QUERY = `#graphql
  query OrderForRefund($id: ID!) {
    order(id: $id) {
      id
      name
      refundable
      displayFinancialStatus
      refunds {
        id
        note
      }
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

// refundCreate の userErrors は UserError 型で、field と message しかない（code は無い）。
// code を選ぶと GraphQL の検証で 500 になり、返金がすべて失敗する（開発ストアで確かめた 2026-11-23）。
// 一時エラー（同じ冪等キーの実行中など）は最上位の errors[].extensions.code で来る。
export const REFUND_CREATE_MUTATION = `#graphql
  mutation RefundCreate($input: RefundInput!, $idempotencyKey: String!) {
    refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
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

type RefundCreateJson = {
  data?: {
    refundCreate?: {
      refund?: { id?: string };
      userErrors?: { field?: string[] | null; message: string }[];
    };
  };
  errors?: { message?: string; extensions?: { code?: string } }[];
};

type GraphqlErrorLike = { message?: string; extensions?: { code?: string } };

/**
 * @shopify/shopify-api の GraphqlQueryError（body.errors.graphQLErrors）や、
 * body.errors が配列の形の例外から GraphQL の errors を取り出す。取り出せなければ null。
 */
export function graphqlErrorsFromThrown(err: unknown): GraphqlErrorLike[] | null {
  if (!err || typeof err !== "object") return null;
  const body = (err as { body?: { errors?: unknown } }).body;
  const errors = body?.errors as unknown;
  const list = Array.isArray(errors)
    ? errors
    : errors && typeof errors === "object" && Array.isArray((errors as { graphQLErrors?: unknown }).graphQLErrors)
      ? ((errors as { graphQLErrors: unknown[] }).graphQLErrors)
      : null;
  if (!list || list.length === 0) return null;
  return list.map((e) => {
    const o = (e ?? {}) as GraphqlErrorLike;
    return { message: String(o.message ?? ""), extensions: { code: o.extensions?.code } };
  });
}

type OrderTx = {
  id: string;
  kind?: string;
  status?: string;
  gateway?: string;
  /** Shopify の OrderTransaction.manualPaymentGateway（手動の決済か） */
  manualPaymentGateway?: boolean | null;
  amountSet?: { shopMoney?: { amount?: string } };
};

type ExistingRefund = {
  id: string;
  note?: string | null;
};

export function refundEventMarker(idempotencyKey: string): string {
  return `[POS_RECEIPT_EVENT:${idempotencyKey}]`;
}

export function refundNoteMatchesEvent(
  note: string | null | undefined,
  idempotencyKey: string,
): boolean {
  const marker = refundEventMarker(idempotencyKey);
  const value = String(note ?? "");
  return value === marker || value.startsWith(`${marker} /`);
}

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
  // レシート現金調整は記録だけ（T の決定 2026-11-23: 「取消」は返金を取り消して売上に戻す意味。Shopify では返金しない）。
  // shopifyExecuteReceiptCashAdjustment は使わない（前の設定値が残っていても返金しない）
  if (eventType === "receipt_cash_adjustment") {
    void adjustKind;
    return false;
  }
  return false;
}

export function pickParentTransactions(
  transactions: OrderTx[],
  preferGateway?: string | null,
): OrderTx[] {
  const sales = transactions.filter(isSaleTransaction);
  if (sales.length === 0) return [];
  if (preferGateway) {
    const gw = String(preferGateway).toLowerCase();
    const matched = sales.filter((t) => String(t.gateway ?? "").toLowerCase().includes(gw));
    if (matched.length > 0) return matched;
    // 選択した元手段と異なる親へ返金すると、実手段への振替元を確定できない。
    // 二重控除を避けるため別 gateway への暗黙 fallback は行わない。
    return [];
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
  return `元の支払い（${String(mismatched.gateway ?? "決済会社")}）は Shopify で返金するとカード等に戻るため、別の返金方法で返した調整は記録だけにしました（Shopify では返金していません）`;
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
    /** Shopify refundCreate の再送でも同じ値を使う。 */
    idempotencyKey: string;
  },
): Promise<ShopifyRefundExecutionResult> {
  const orderId = orderGid(params.sourceOrderId);
  const refundAmount = Number(params.amount);
  if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
    return { status: "failed", error: "返金金額が不正です" };
  }

  const json = await adminGraphqlWithRetry<{
    data?: {
      order?: {
        id?: string;
        refundable?: boolean;
        transactions?: OrderTx[];
        refunds?: ExistingRefund[];
      };
    };
    errors?: { message?: string }[];
  }>(admin, ORDER_FOR_REFUND_QUERY, {
    variables: { id: orderId },
  });

  if (json.errors?.length) {
    return { status: "failed", error: json.errors.map((e) => e.message).join("; ") };
  }

  const order = json.data?.order;
  if (!order?.id) {
    return { status: "failed", error: "注文が見つかりません" };
  }
  const eventMarker = refundEventMarker(params.idempotencyKey);
  const existingRefund = (order.refunds ?? []).find((refund) =>
    refundNoteMatchesEvent(refund.note, params.idempotencyKey),
  );
  if (existingRefund?.id) {
    return { status: "success", refundId: existingRefund.id };
  }
  // refundable=false でも、直前の同じ冪等キーによる返金が成功済みの再送では
  // refundCreate を同じ入力で再実行して Shopify の保存済み応答を受け取る必要がある。
  // 新規の返金不可は mutation の userErrors を正本として扱う。

  // Shopify の返金先は実際に払い出す手段ではなく、元売上の親取引。
  // 複数決済では original を優先し、対象が無ければ安全に失敗させる。
  const preferGw =
    params.originalPaymentMethod || params.actualRefundMethod || null;
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
    eventMarker,
    "特殊返金",
    params.eventType,
    params.note?.trim() || "",
  ].filter(Boolean);

  let refundJson: RefundCreateJson;
  try {
    refundJson = await adminGraphqlWithRetry<RefundCreateJson>(admin, REFUND_CREATE_MUTATION, {
    variables: {
      idempotencyKey: params.idempotencyKey,
      input: {
        orderId: order.id,
        notify: false,
        note: noteParts.join(" / ").slice(0, 500),
        transactions: refundTxs,
      },
    },
    });
  } catch (err) {
    // 本物の admin.graphql は応答に errors があると JSON で返さず GraphqlQueryError を投げる。
    // 投げられた errors も応答の errors と同じく分類する（同じキーの実行中は retryable）。
    // errors を持たない例外（通信の失敗など）は今までどおりそのまま上げる（pending のまま残る）。
    const thrown = graphqlErrorsFromThrown(err);
    if (!thrown) throw err;
    refundJson = { errors: thrown };
  }

  if (refundJson.errors?.length) {
    const error = refundJson.errors.map((e) => e.message).join("; ");
    const classified = refundJson.errors.map((e) => ({
      code: e.extensions?.code,
      message: e.message,
    }));
    return isRetryableRefundError(classified)
      ? { status: "retryable", error }
      : { status: "failed", error };
  }

  const payload = refundJson.data?.refundCreate;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length > 0) {
    const error = userErrors.map((e) => e.message).join("; ");
    return isRetryableRefundError(userErrors)
      ? { status: "retryable", error }
      : { status: "failed", error };
  }

  const refundId = payload?.refund?.id;
  if (!refundId) {
    return { status: "failed", error: "返金IDが取得できませんでした" };
  }

  return { status: "success", refundId };
}
