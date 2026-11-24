import assert from "node:assert/strict";
import { mock, test } from "node:test";

const source = '<!DOCTYPE html><html><head></head><body><p>合計 ¥35</p></body></html>';
let profile = "mcp31lb_58";
let paper: 58 | 80 = 58;
let layoutEnabled = true;
let snapshotEnabled = true;
let layoutFails = false;
const snapshot = { renderedHtmlByPaperWidth: { 58: source, 80: source } };
const settings: Record<string, unknown> = {};
mock.module("../db.server", { defaultExport: {
  settlement: { findFirst: async () => ({ id: "s1", locationId: "l1", periodLabel: "精算", paymentSectionsJson: "[]" }) },
  receiptIssue: { findFirst: async () => ({ id: "r1", printSnapshotJson: snapshotEnabled ? "snapshot" : null, amount: 35, createdAt: new Date("2026-11-24T00:00:00Z") }) },
  location: { findFirst: async () => ({ name: "サンプル" }) },
  receiptTemplate: { findFirst: async () => null },
} });
mock.module("../utils/posAuth.server", { namedExports: {
  authenticatePosRequestOrCorsError: async () => ({ shop: { id: "shop", shopDomain: "test", planCode: "pro" }, admin: { graphql: async () => Response.json({ data: { order: { name: "#1", lineItems: { nodes: [], pageInfo: { hasNextPage: false } } } } }) } }),
  corsHtml: (_request: Request, html: string, init?: ResponseInit) => new Response(html, init),
  corsErrorJson: (_request: Request, data: unknown, status: number) => Response.json(data, { status }),
  corsPreflightResponse: () => new Response(null),
} });
mock.module("../utils/appSettings.server", { namedExports: {
  PRINT_SETTINGS_KEY: "print", getAppSetting: async (_s: string, key: string) => key === "print" ? { receiptPrinterProfile: profile, paperWidthMm: paper } : { enabled: true, paperWidthMm: paper },
  setAppSetting: async (_s: string, key: string, val: unknown) => { settings[key] = val; },
} });
mock.module("../utils/planFeatures.server", { namedExports: { getFullAccess: async () => true, checkPlanAccess: () => ({ allowed: true }) } });
mock.module("../utils/shopTimezone.server", { namedExports: { getShopTimezoneForDaily: async () => "Asia/Tokyo" } });
mock.module("./receiptLayoutPrint.server", { namedExports: { PRINT_CSP: "script-src 'none'", getPrintLayout: async () => layoutEnabled ? {} : null } });
mock.module("./receiptLayoutSettlementPrint.server", { namedExports: { layoutSettlementHtml: async () => layoutFails ? null : source } });
mock.module("./receiptLayoutOrderPrint.server", { namedExports: { layoutOrderHtml: async () => layoutFails ? { status: "fallback" } : { status: "ok", html: source } } });
mock.module("./printMarks", { namedExports: { applyPrintMarksToLayoutHtml: (s: string) => s, insertPrintMarkAtTop: (s: string) => s, printMarksFor: () => [] } });
mock.module("./printMarks.server", { namedExports: { getPrintMarkSettings: async () => ({}), wasPrinted: async () => false } });
mock.module("./settlementPrintSnapshot.server", { namedExports: { buildSettlementReprintView: () => ({ html: source }), isResettlementRow: () => false, parsePaymentSectionsJson: () => ({ snapshot: {} }) } });
mock.module("./receiptPrintSnapshot.server", { namedExports: { parseReceiptPrintSnapshot: () => snapshotEnabled ? snapshot : null } });
mock.module("../routes/api.settings.receipt-template", { namedExports: { DEFAULT_TEMPLATE: {}, normalizeTemplateData: (o: unknown) => o } });
mock.module("./printReceiptHtml", { namedExports: { renderPrintReceiptHtml: () => source } });
mock.module("./salesReceiptPrint.server", { namedExports: { SALES_RECEIPT_ORDER_QUERY: "query", buildSalesReceiptHtml: () => source } });
mock.module("./giftOrderReceipt", { namedExports: { GIFT_ORDER_QUERY: "query", giftOrderHtml: async () => source } });
const settlement = await import("../routes/api.print.settlement.$id");
const receipt = await import("../routes/api.print.receipt.$id");
const sales = await import("../routes/api.print.sales.$orderId");

test("全印字出口: layout/旧帳票/fallback/保存領収書/ギフトへ機器設定を現在値で適用し、80mm・OFFで元に戻る", async () => {
  for (const enabled of [true, false]) for (const fail of [false, true]) {
    layoutEnabled = enabled; layoutFails = fail; snapshotEnabled = enabled;
    for (const width of [58, 80] as const) for (const selected of ["mcp31lb_58", "mpop_58", "standard"]) {
      paper = width; profile = selected;
      for (const [route, query] of [[settlement, ""], [receipt, ""], [sales, ""], [sales, "?copy=gift"]] as const) {
        const response = await route.loader({ request: new Request("https://test.local/print" + query), params: { id: "1", orderId: "1" }, context: {} } as never);
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.equal(html.includes('data-receipt-printer-content="1"'), width === 58 && selected === "mcp31lb_58");
        assert.ok(html.includes('合計 ¥35'));
      }
    }
  }
  assert.equal(snapshot.renderedHtmlByPaperWidth[58], source, "発行済みスナップショットを補正済みHTMLで上書きしない");
});
