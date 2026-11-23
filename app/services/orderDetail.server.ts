/**
 * 注文詳細の GraphQL 取得・POS 向け JSON 整形
 */
import { formatTimeHmInTimeZone } from "../utils/shopTimezone.server";
import {
  matchPaymentMethodMaster,
  PAYMENT_METHOD_FALLBACK_LABELS,
  type PaymentMethodMatchInput,
} from "../utils/paymentMethodMatch.server";

export const ORDER_DETAIL_QUERY = `#graphql
  query OrderDetail($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      processedAt
      cancelledAt
      displayFinancialStatus
      taxesIncluded
      note
      totalPriceSet { shopMoney { amount currencyCode } }
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
      totalDiscountsSet { shopMoney { amount currencyCode } }
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      customer {
        id
        displayName
        email
      }
      retailLocation {
        id
        name
      }
      lineItems(first: 100) {
        nodes {
          id
          title
          name
          quantity
          sku
          variant {
            id
          }
          refundableQuantity
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          discountedUnitPriceSet { shopMoney { amount currencyCode } }
          customAttributes {
            key
            value
          }
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
          taxLines {
            rate
            title
            priceSet { shopMoney { amount currencyCode } }
          }
        }
      }
      transactions(first: 50) {
        id
        kind
        status
        gateway
        formattedGateway
        amountSet { shopMoney { amount currencyCode } }
        createdAt
      }
      refunds {
        id
        createdAt
        totalRefundedSet { shopMoney { amount currencyCode } }
        transactions(first: 20) {
          nodes {
            gateway
            formattedGateway
            amountSet { shopMoney { amount currencyCode } }
          }
        }
      }
    }
  }
`;

type MoneyBag = { shopMoney?: { amount?: string; currencyCode?: string } };

function moneyAmount(m?: MoneyBag | null): string {
  return m?.shopMoney?.amount ?? "0";
}

function moneyCurrency(m?: MoneyBag | null): string {
  return m?.shopMoney?.currencyCode ?? "JPY";
}

/** POS / Shopify に記録された決済名をそのまま表示 */
/**
 * 店の人に見せる支払方法の名前。
 * 支払方法マスタの表示名 → 既定の日本語（cash → 現金 など）→ Shopify の名前 の順に使う。
 * 名前を変えるだけで、gateway（数えるときに使う値）はそのまま。
 */
export function paymentDisplayLabel(
  gateway: string | null | undefined,
  formattedGateway: string | null | undefined,
  masters: PaymentMethodMatchInput[],
): string {
  const gw = String(gateway ?? "").trim();
  const fmt = String(formattedGateway ?? "").trim();
  const matched =
    (gw ? matchPaymentMethodMaster(gw, masters) : null) ??
    (fmt ? matchPaymentMethodMaster(fmt, masters) : null);
  if (matched?.displayLabel) return matched.displayLabel;
  const fallback = PAYMENT_METHOD_FALLBACK_LABELS[gw.toLowerCase()];
  if (gw && fallback) return fallback;
  return transactionDisplayName(gw, fmt);
}

type DetailTx = { gateway?: unknown; formattedGateway?: unknown; displayName?: unknown };

/** serializeOrderDetail の結果の支払い・返金の displayName を、店の人向けの名前に置き換える */
export function applyPaymentDisplayLabels<T extends Record<string, unknown>>(
  detail: T,
  masters: PaymentMethodMatchInput[],
): T {
  const relabel = (tx: DetailTx) => ({
    ...tx,
    displayName: paymentDisplayLabel(
      tx.gateway as string | null | undefined,
      tx.formattedGateway as string | null | undefined,
      masters,
    ),
  });
  const transactions = ((detail.transactions as DetailTx[] | undefined) ?? []).map(relabel);
  const refunds = ((detail.refunds as (Record<string, unknown> & { transactions?: DetailTx[] })[] | undefined) ?? []).map(
    (r) => ({ ...r, transactions: (r.transactions ?? []).map(relabel) }),
  );
  return { ...detail, transactions, refunds };
}

export function transactionDisplayName(gateway?: string | null, formattedGateway?: string | null): string {
  const fmt = String(formattedGateway ?? "").trim();
  if (fmt) return fmt;
  const gw = String(gateway ?? "").trim();
  return gw || "—";
}

function discountApplicationLabel(app: Record<string, unknown> | null | undefined): string {
  if (!app) return "割引";
  const t = String(app.__typename ?? "");
  if (t.includes("DiscountCodeApplication")) return String(app.code ?? "割引コード");
  if (t.includes("ManualDiscountApplication")) return String(app.title ?? "手動割引");
  if (t.includes("AutomaticDiscountApplication")) return String(app.title ?? "自動割引");
  if (t.includes("ScriptDiscountApplication")) return String(app.title ?? "スクリプト割引");
  return "割引";
}

export function serializeOrderDetail(
  order: Record<string, unknown>,
  opts?: { timezone?: string },
): Record<string, unknown> {
  const tz = opts?.timezone ?? "Asia/Tokyo";
  const createdAt = String(order.createdAt ?? "");
  const lineNodes = (order.lineItems as { nodes?: Record<string, unknown>[] })?.nodes ?? [];
  const txList = (order.transactions as Record<string, unknown>[]) ?? [];
  const refundList = (order.refunds as Record<string, unknown>[]) ?? [];

  const lineItems = lineNodes.map((li) => {
    const qty = Number(li.quantity ?? 0);
    const unit = Number(moneyAmount(li.discountedUnitPriceSet as MoneyBag) || moneyAmount(li.originalUnitPriceSet as MoneyBag));
    const discounts = ((li.discountAllocations as Record<string, unknown>[]) ?? []).map((da) => ({
      label: discountApplicationLabel(da.discountApplication as Record<string, unknown>),
      amount: moneyAmount(da.allocatedAmountSet as MoneyBag),
    }));
    const taxLines = ((li.taxLines as Record<string, unknown>[]) ?? []).map((tl) => ({
      title: String(tl.title ?? "税"),
      rate: tl.rate,
      amount: moneyAmount(tl.priceSet as MoneyBag),
    }));
    const lineName = String(li.name ?? "");
    const titleOnly = String(li.title ?? "");
    let variantTitle = "";
    if (lineName && titleOnly && lineName !== titleOnly) {
      const suffix = lineName.slice(titleOnly.length).replace(/^[\s\-–—]+/, "");
      if (suffix) variantTitle = suffix;
    }
    // LineItem.staffMember は read_users が要り、無い店では ACCESS_DENIED で注文の取得ごと 500 になる。
    // read_users は足さない（T の判断）ので読まない。帰属スタッフはアプリの記録（#84）から入れる。
    const staffName = "";
    return {
      id: li.id,
      title: titleOnly || lineName,
      variantTitle,
      quantity: qty,
      sku: li.sku ?? "",
      variantId: (li.variant as { id?: string } | null)?.id ?? null,
      barcode: "",
      originalUnitPrice: moneyAmount(li.originalUnitPriceSet as MoneyBag),
      discountedUnitPrice: moneyAmount(li.discountedUnitPriceSet as MoneyBag),
      lineTotal: String(Math.round(unit * qty)),
      refundableQuantity: Number(li.refundableQuantity ?? 0),
      staffMemberName: staffName,
      customAttributes: ((li.customAttributes as { key?: string; value?: string }[]) ?? []).map((a) => ({
        key: a.key,
        value: a.value,
      })),
      discounts,
      taxLines,
    };
  });

  const saleTransactions = txList.filter((tx) => String(tx.kind ?? "").toUpperCase() === "SALE");
  const transactions = (saleTransactions.length > 0 ? saleTransactions : txList).map((tx) => ({
    id: tx.id,
    kind: tx.kind,
    status: tx.status,
    gateway: tx.gateway,
    formattedGateway: tx.formattedGateway,
    displayName: transactionDisplayName(
      tx.gateway as string,
      tx.formattedGateway as string,
    ),
    amount: moneyAmount(tx.amountSet as MoneyBag),
    currency: moneyCurrency(tx.amountSet as MoneyBag),
    createdAt: tx.createdAt,
  }));

  const refunds = refundList.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    // 店のタイムゾーンの「11/23 18:31」（画面は UTC の時刻を出さない）
    createdAtLabel: r.createdAt
      ? new Intl.DateTimeFormat("ja-JP", {
          timeZone: tz,
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(String(r.createdAt)))
      : "",
    totalRefunded: moneyAmount(r.totalRefundedSet as MoneyBag),
    currency: moneyCurrency(r.totalRefundedSet as MoneyBag),
    transactions: (
      (r.transactions as { nodes?: Record<string, unknown>[] })?.nodes ?? []
    ).map((rtx) => ({
      gateway: rtx.gateway,
      formattedGateway: rtx.formattedGateway,
      displayName: transactionDisplayName(
        rtx.gateway as string,
        rtx.formattedGateway as string,
      ),
      amount: moneyAmount(rtx.amountSet as MoneyBag),
    })),
  }));

  const customer = order.customer as { id?: string; displayName?: string; email?: string } | null;
  const loc = order.retailLocation as { id?: string; name?: string } | null;

  return {
    orderId: String(order.id ?? "").replace("gid://shopify/Order/", ""),
    orderName: order.name,
    createdAt,
    processedAt: order.processedAt ?? null,
    cancelledAt: order.cancelledAt ?? null,
    financialStatus: order.displayFinancialStatus,
    taxesIncluded: Boolean(order.taxesIncluded),
    note: order.note ?? "",
    transactionTime: createdAt ? formatTimeHmInTimeZone(createdAt, tz) : "",
    transactionDateTime: createdAt
      ? new Intl.DateTimeFormat("ja-JP", {
          timeZone: tz,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(createdAt))
      : "",
    totalPrice: order.totalPriceSet
      ? {
          amount: moneyAmount(order.totalPriceSet as MoneyBag),
          currencyCode: moneyCurrency(order.totalPriceSet as MoneyBag),
        }
      : { amount: "0", currencyCode: "JPY" },
    subtotalPrice: {
      amount: moneyAmount(order.subtotalPriceSet as MoneyBag),
      currencyCode: moneyCurrency(order.subtotalPriceSet as MoneyBag),
    },
    totalTax: {
      amount: moneyAmount(order.totalTaxSet as MoneyBag),
      currencyCode: moneyCurrency(order.totalTaxSet as MoneyBag),
    },
    totalDiscounts: {
      amount: moneyAmount(order.totalDiscountsSet as MoneyBag),
      currencyCode: moneyCurrency(order.totalDiscountsSet as MoneyBag),
    },
    customer: customer
      ? {
          id: customer.id,
          displayName: customer.displayName,
          email: customer.email,
        }
      : null,
    location: loc ? { id: loc.id, name: loc.name } : null,
    lineItems,
    transactions,
    refunds,
  };
}
