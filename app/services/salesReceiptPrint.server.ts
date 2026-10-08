/**
 * 販売レシート: 注文＋属性取得 → 印字 HTML モデル
 */
import {
  renderPrintReceiptHtml,
  type PrintAttr,
  type SalesReceiptPrintModel,
} from "./printReceiptHtml";
import type { SalesReceiptSettings } from "../utils/salesReceiptSettings";
import { formatTimeHmInTimeZone } from "../utils/shopTimezone.server";

export const SALES_RECEIPT_ORDER_QUERY = `#graphql
  query SalesReceiptOrder($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      note
      customAttributes { key value }
      totalPriceSet { shopMoney { amount currencyCode } }
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
      totalDiscountsSet { shopMoney { amount currencyCode } }
      retailLocation { id name }
      lineItems(first: 100) {
        nodes {
          title
          name
          quantity
          sku
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          discountedUnitPriceSet { shopMoney { amount currencyCode } }
          customAttributes { key value }
        }
      }
      transactions(first: 50) {
        kind
        status
        gateway
        formattedGateway
        amountSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

type MoneyBag = { shopMoney?: { amount?: string; currencyCode?: string } };

function money(m?: MoneyBag | null): number {
  return Number(m?.shopMoney?.amount ?? 0) || 0;
}

function currencyOf(m?: MoneyBag | null): string {
  return m?.shopMoney?.currencyCode ?? "JPY";
}

function mapAttrs(raw: { key?: string; value?: string }[] | null | undefined): PrintAttr[] {
  return (raw ?? [])
    .map((a) => ({ key: String(a.key ?? ""), value: String(a.value ?? "") }))
    .filter((a) => a.key || a.value);
}

export function buildSalesReceiptPrintModel(
  order: Record<string, unknown>,
  settings: SalesReceiptSettings,
  opts?: { timezone?: string; shopName?: string },
): SalesReceiptPrintModel {
  const tz = opts?.timezone ?? "Asia/Tokyo";
  const createdAt = String(order.createdAt ?? "");
  const createdAtLabel = createdAt
    ? new Intl.DateTimeFormat("ja-JP", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(createdAt))
    : formatTimeHmInTimeZone(createdAt, tz);

  const lineNodes = (order.lineItems as { nodes?: Record<string, unknown>[] })?.nodes ?? [];
  const lineItems = lineNodes.map((li) => {
    const qty = Number(li.quantity ?? 0);
    const unit = money((li.discountedUnitPriceSet as MoneyBag) || (li.originalUnitPriceSet as MoneyBag));
    const titleOnly = String(li.title ?? "");
    const lineName = String(li.name ?? "");
    let variantTitle = "";
    if (lineName && titleOnly && lineName !== titleOnly) {
      variantTitle = lineName.slice(titleOnly.length).replace(/^[\s\-–—]+/, "");
    }
    return {
      title: titleOnly || lineName,
      variantTitle,
      quantity: qty,
      unitPrice: unit,
      lineTotal: Math.round(unit * qty),
      sku: String(li.sku ?? ""),
      customAttributes: mapAttrs(li.customAttributes as { key?: string; value?: string }[]),
    };
  });

  const txList = (order.transactions as Record<string, unknown>[]) ?? [];
  const saleTx = txList.filter((tx) => String(tx.kind ?? "").toUpperCase() === "SALE");
  const payments = (saleTx.length > 0 ? saleTx : txList).map((tx) => ({
    label: String(tx.formattedGateway || tx.gateway || "支払"),
    amount: money(tx.amountSet as MoneyBag),
  }));

  const totalSet = order.totalPriceSet as MoneyBag;
  const loc = order.retailLocation as { name?: string } | null;

  const paperWidthMm = settings.paperWidthMm === 58 ? 58 : 80;

  return {
    kind: "sales",
    shopName: opts?.shopName || settings.headerTitle || "レシート",
    orderName: String(order.name ?? ""),
    createdAtLabel,
    locationName: loc?.name ?? "",
    currency: currencyOf(totalSet),
    subtotal: money(order.subtotalPriceSet as MoneyBag),
    tax: money(order.totalTaxSet as MoneyBag),
    discounts: money(order.totalDiscountsSet as MoneyBag),
    total: money(totalSet),
    lineItems,
    orderAttributes: mapAttrs(order.customAttributes as { key?: string; value?: string }[]),
    payments,
    footerNote: settings.footerNote || undefined,
    showOrderAttributes: settings.printOrderAttributes,
    showLineAttributes: settings.printLineAttributes,
    paperWidthMm,
  };
}

export function buildSalesReceiptHtml(
  order: Record<string, unknown>,
  settings: SalesReceiptSettings,
  opts?: { timezone?: string; shopName?: string },
): string {
  return renderPrintReceiptHtml(buildSalesReceiptPrintModel(order, settings, opts));
}
