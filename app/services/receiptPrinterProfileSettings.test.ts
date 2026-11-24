import assert from "node:assert/strict";
import { mock, test } from "node:test";
let saved: Record<string, unknown> = { receiptPrinterProfile: "standard", paperWidthMm: 58, cloudprntPaperWidth: "58mm" };
const stored = new Map<string, unknown>();
mock.module("../db.server", {defaultExport:{receiptTemplate:{findFirst:async()=>null}}});
mock.module("../shopify.server", { namedExports: { authenticate: { admin: async () => ({ admin: {}, session: { shop: "test" } }) } } });
mock.module("../utils/shopResolver.server", { namedExports: { resolveShop: async () => ({ id: "shop" }) } });
mock.module("../utils/appSettings.server", { namedExports: {
  PRINT_SETTINGS_KEY: "print", DEFAULT_PRINT_SETTINGS: {}, SALES_RECEIPT_SETTINGS_KEY: "sales",
  getAppSetting: async (_id: string, key: string) => key === "print" ? saved : stored.get(key),
  setAppSetting: async (_id: string, key: string, value: unknown) => { stored.set(key, value); if (key === "print") saved = value as Record<string, unknown>; },
} });
const page = await import("../routes/app.print-settings");
const layoutPage = await import("../routes/app.receipt-layouts.$kind");

test("共通設定を一度保存すると全4帳票で読み込む。既存入力・80mm用紙選択を保持し、補正未送信は保持", async () => {
  for (const selected of ["mcp31lb_58", "mpop_58", "standard"]) {
    const body = new FormData(); body.set("receiptPrinterProfile", selected); body.set("cloudprntPaperWidth", "58mm");
    const response = await page.action({ request: new Request("https://test.local/app/print-settings", { method: "POST", body }), context: {}, params: {} } as never);
    assert.equal(response.status, 200);
    assert.equal(saved.receiptPrinterProfile, selected);
    assert.equal(saved.paperWidthMm, 58);
    for (const kind of ["settlement", "receipt", "sales", "gift"]) {
      const loaded = await layoutPage.loader({ request: new Request("https://test.local/app/receipt-layouts/" + kind), params: { kind }, context: {} } as never);
      assert.equal(loaded.printerProfile, selected);
    }
  }
  saved.receiptPrinterProfile = "mcp31lb_58";
  const body = new FormData(); body.set("cloudprntPaperWidth", "80mm");
  await page.action({ request: new Request("https://test.local/app/print-settings", { method: "POST", body }), context: {}, params: {} } as never);
  assert.equal(saved.receiptPrinterProfile, "mcp31lb_58");
  assert.equal(saved.paperWidthMm, 80);
});
