import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderPrintReceiptHtml,
  settlementPreviewToPrintModel,
} from "./printReceiptHtml";
import { buildSalesReceiptPrintModel } from "./salesReceiptPrint.server";
import { DEFAULT_SALES_RECEIPT_SETTINGS } from "../utils/salesReceiptSettings";

describe("printReceiptHtml", () => {
  it("renders sales receipt with order and line attributes", () => {
    const model = buildSalesReceiptPrintModel(
      {
        name: "#1001",
        createdAt: "2026-10-08T04:00:00Z",
        customAttributes: [{ key: "memo", value: "gift" }],
        totalPriceSet: { shopMoney: { amount: "1100", currencyCode: "JPY" } },
        subtotalPriceSet: { shopMoney: { amount: "1000", currencyCode: "JPY" } },
        totalTaxSet: { shopMoney: { amount: "100", currencyCode: "JPY" } },
        totalDiscountsSet: { shopMoney: { amount: "0", currencyCode: "JPY" } },
        retailLocation: { name: "渋谷" },
        lineItems: {
          nodes: [
            {
              title: "Tea",
              name: "Tea - L",
              quantity: 1,
              sku: "T1",
              discountedUnitPriceSet: { shopMoney: { amount: "1000", currencyCode: "JPY" } },
              customAttributes: [{ key: "size", value: "L" }],
            },
          ],
        },
        transactions: [
          {
            kind: "SALE",
            formattedGateway: "現金",
            amountSet: { shopMoney: { amount: "1100", currencyCode: "JPY" } },
          },
        ],
      },
      DEFAULT_SALES_RECEIPT_SETTINGS,
      { timezone: "Asia/Tokyo", shopName: "Demo" },
    );
    const html = renderPrintReceiptHtml(model);
    assert.match(html, /#1001/);
    assert.match(html, /memo/);
    assert.match(html, /gift/);
    assert.match(html, /size/);
    assert.match(html, /Tea/);
  });

  it("omits attributes when toggles are off", () => {
    const model = buildSalesReceiptPrintModel(
      {
        name: "#1002",
        createdAt: "2026-10-08T04:00:00Z",
        customAttributes: [{ key: "memo", value: "hidden" }],
        totalPriceSet: { shopMoney: { amount: "100", currencyCode: "JPY" } },
        subtotalPriceSet: { shopMoney: { amount: "100", currencyCode: "JPY" } },
        totalTaxSet: { shopMoney: { amount: "0", currencyCode: "JPY" } },
        totalDiscountsSet: { shopMoney: { amount: "0", currencyCode: "JPY" } },
        lineItems: {
          nodes: [
            {
              title: "Item",
              quantity: 1,
              discountedUnitPriceSet: { shopMoney: { amount: "100", currencyCode: "JPY" } },
              customAttributes: [{ key: "x", value: "y" }],
            },
          ],
        },
        transactions: [],
      },
      {
        ...DEFAULT_SALES_RECEIPT_SETTINGS,
        printOrderAttributes: false,
        printLineAttributes: false,
      },
    );
    const html = renderPrintReceiptHtml(model);
    assert.doesNotMatch(html, /hidden/);
    assert.doesNotMatch(html, />x</);
  });

  it("applies layoutJson showSku/showPayments/showLocation on real print model", () => {
    const baseOrder = {
      name: "#1003",
      createdAt: "2026-10-08T04:00:00Z",
      customAttributes: [],
      totalPriceSet: { shopMoney: { amount: "1100", currencyCode: "JPY" } },
      subtotalPriceSet: { shopMoney: { amount: "1000", currencyCode: "JPY" } },
      totalTaxSet: { shopMoney: { amount: "100", currencyCode: "JPY" } },
      totalDiscountsSet: { shopMoney: { amount: "0", currencyCode: "JPY" } },
      retailLocation: { name: "渋谷" },
      lineItems: {
        nodes: [
          {
            title: "Tea",
            quantity: 1,
            sku: "T1",
            discountedUnitPriceSet: { shopMoney: { amount: "1000", currencyCode: "JPY" } },
            customAttributes: [],
          },
        ],
      },
      transactions: [
        {
          kind: "SALE",
          formattedGateway: "現金",
          amountSet: { shopMoney: { amount: "1100", currencyCode: "JPY" } },
        },
      ],
    };

    const offHtml = renderPrintReceiptHtml(
      buildSalesReceiptPrintModel(baseOrder, {
        ...DEFAULT_SALES_RECEIPT_SETTINGS,
        layoutJson: { showSku: false, showPayments: false, showLocation: false },
      }),
    );
    assert.doesNotMatch(offHtml, /SKU:\s*T1/);
    assert.doesNotMatch(offHtml, /渋谷/);
    assert.doesNotMatch(offHtml, /現金/);

    const onHtml = renderPrintReceiptHtml(
      buildSalesReceiptPrintModel(baseOrder, {
        ...DEFAULT_SALES_RECEIPT_SETTINGS,
        layoutJson: { showSku: true, showPayments: true, showLocation: true },
      }),
    );
    assert.match(onHtml, /SKU:\s*T1/);
    assert.match(onHtml, /渋谷/);
    assert.match(onHtml, /現金/);
  });

  it("renders settlement and gift receipt HTML", () => {
    const settlementHtml = renderPrintReceiptHtml(
      settlementPreviewToPrintModel({
        targetDate: "2026-10-08",
        locationName: "渋谷",
        total: 1000,
        netSales: 900,
        tax: 100,
        discounts: 0,
        refundTotal: 0,
        orderCount: 1,
        refundCount: 0,
        itemCount: 2,
        voucherChangeAmount: 0,
        paymentSections: [{ label: "現金", net: 1000, txCount: 1 }],
      }),
    );
    assert.match(settlementHtml, /精算レシート/);
    assert.match(settlementHtml, /現金/);

    const giftHtml = renderPrintReceiptHtml({
      kind: "receipt",
      title: "領　収　書",
      recipientName: "山田",
      proviso: "お買上品代として",
      amount: 5000,
      currency: "JPY",
      issueDate: "2026-10-08",
      orderName: "#99",
      paperWidthMm: 80,
    });
    assert.match(giftHtml, /山田/);
    assert.match(giftHtml, /5000|¥5,000/);
  });
});
