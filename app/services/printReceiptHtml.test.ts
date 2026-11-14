import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderPrintReceiptHtml,
  settlementPreviewToPrintModel,
} from "./printReceiptHtml";
import { buildSalesReceiptPrintModel } from "./salesReceiptPrint.server";
import { DEFAULT_SALES_RECEIPT_SETTINGS } from "../utils/salesReceiptSettings";

describe("printReceiptHtml", () => {
  it("reflows long sales content for 58mm without scaling the 80mm layout", () => {
    const common = {
      kind: "sales" as const,
      shopName: "Demo",
      orderName: "#WIDTH-1",
      createdAtLabel: "2026-11-14 15:00",
      locationName: "ルミネエスト新宿",
      currency: "JPY",
      subtotal: 1234567,
      tax: 123456,
      discounts: 12000,
      total: 1346023,
      lineItems: [
        {
          title: "とても長い商品名でも文字を小さくせず複数行へ折り返して印字するテスト商品",
          variantTitle: "シルバー / ロングバリエーション",
          quantity: 123,
          unitPrice: 123456,
          lineTotal: 15185088,
        },
      ],
      payments: [{ label: "クレジットカード", amount: 1346023 }],
      showOrderAttributes: false,
      showLineAttributes: false,
    };

    const at80 = renderPrintReceiptHtml({ ...common, paperWidthMm: 80 });
    const at58 = renderPrintReceiptHtml({ ...common, paperWidthMm: 58 });

    assert.match(at80, /@page \{ size: auto;/);
    assert.match(at80, /@media print \{\s*html, body \{ width: 100%; max-width: 80mm;/);
    assert.match(at58, /@media print \{\s*html, body \{ width: 100%; max-width: 58mm;/);
    assert.match(at80, /class="paper-80" data-paper-width-mm="80"/);
    assert.match(at58, /class="paper-58" data-paper-width-mm="58"/);
    assert.match(at80, /font-size: 13px/);
    assert.match(at58, /font-size: 13px/);
    assert.match(at80, /grid-template-columns: minmax\(7em, 1fr\) minmax\(0, 68%\)/);
    assert.match(at58, /grid-template-columns: minmax\(5em, 1fr\) minmax\(0, 55%\)/);
    assert.match(at58, /overflow-wrap: anywhere/);
    assert.doesNotMatch(at58, /transform\s*:\s*scale/i);
    assert.match(at58, /とても長い商品名/);
    assert.match(at58, /×123/);
    assert.match(at58, /¥15,185,088/);
  });

  it("uses the selected physical width for settlement and receipt output", () => {
    const settlement = renderPrintReceiptHtml(
      settlementPreviewToPrintModel(
        {
          targetDate: "2026-11-14",
          locationName: "ルミネエスト新宿ロケーション",
          total: 12345678,
          netSales: 11223344,
          tax: 1234567,
          discounts: 98765,
          refundTotal: 12345,
          orderCount: 123,
          refundCount: 12,
          itemCount: 456,
          voucherChangeAmount: 1000,
          paymentSections: [
            { label: "クレジットカード（長い決済手段名）", net: 12345678, txCount: 123 },
          ],
        },
        { paperWidthMm: 58 },
      ),
    );
    const receipt = renderPrintReceiptHtml({
      kind: "receipt",
      title: "領　収　書",
      recipientName: "長い株式会社名 御中",
      proviso: "お買上品代および配送手数料として",
      amount: 12345678,
      currency: "JPY",
      issueDate: "2026-11-14",
      paperWidthMm: 58,
    });

    for (const html of [settlement, receipt]) {
      assert.match(html, /@media print \{\s*html, body \{ width: 100%; max-width: 58mm;/);
      assert.match(html, /class="paper-58" data-paper-width-mm="58"/);
      assert.doesNotMatch(html, /transform\s*:\s*scale/i);
      assert.match(html, /class="amount"/);
    }
  });

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
