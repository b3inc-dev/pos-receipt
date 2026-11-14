import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  UNIFIED_PRINT_MODE,
  allSettlementIdempotencyKeys,
  buildSettlementIdempotencyKey,
  displayPrintModeLabel,
  isLegacyPrintMode,
  legacySettlementIdempotencyKeys,
  resolvePaperWidthMm,
  resolveRuntimePrintMode,
  settlementRowToPreviewDTO,
  shouldCreateSettlementShopifyOrder,
} from "./printUnification.server";
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("print unification", () => {
  it("runtime print mode ignores stored legacy values", () => {
    assert.equal(resolveRuntimePrintMode("order_based"), UNIFIED_PRINT_MODE);
    assert.equal(resolveRuntimePrintMode("cloudprnt_direct"), UNIFIED_PRINT_MODE);
    assert.equal(resolveRuntimePrintMode(null), UNIFIED_PRINT_MODE);
    assert.equal(isLegacyPrintMode("order_based"), true);
    assert.equal(isLegacyPrintMode("shopify_printing"), false);
  });

  it("does not create SETTLEMENT/INSPECTION Shopify orders for any stored flag", () => {
    assert.equal(shouldCreateSettlementShopifyOrder("order_based", {
      createSettlementOrderWhenPrinting: true,
      orderBasedCreateSettlementOrderEnabled: true,
    }), false);
    assert.equal(shouldCreateSettlementShopifyOrder("cloudprnt_direct"), false);
    assert.equal(shouldCreateSettlementShopifyOrder(UNIFIED_PRINT_MODE), false);
  });

  it("keeps reprint idempotency across legacy printMode keys", () => {
    const shopId = "shop_1";
    const locationId = "gid://shopify/Location/1";
    const targetDate = "2026-11-12";
    assert.equal(
      buildSettlementIdempotencyKey(shopId, locationId, targetDate),
      "shop_1:gid://shopify/Location/1:2026-11-12",
    );
    assert.deepEqual(
      legacySettlementIdempotencyKeys(shopId, locationId, targetDate),
      [
        "shop_1:gid://shopify/Location/1:2026-11-12:order_based",
        "shop_1:gid://shopify/Location/1:2026-11-12:cloudprnt_direct",
      ],
    );
    const keys = allSettlementIdempotencyKeys(shopId, locationId, targetDate);
    assert.equal(keys.length, 3);
    assert.ok(keys.every((k) => k.includes(targetDate)));
  });

  it("reads paper width from legacy cloudprntPaperWidth without using CloudPRNT output", () => {
    assert.equal(resolvePaperWidthMm({ cloudprntPaperWidth: "58mm" }), 58);
    assert.equal(resolvePaperWidthMm({ cloudprntPaperWidth: "80mm" }), 80);
    assert.equal(resolvePaperWidthMm({}), 80);
  });

  it("rebuilds reprint preview from saved settlement amounts", () => {
    const preview = settlementRowToPreviewDTO(
      {
        locationId: "gid://shopify/Location/1",
        targetDate: "2026-11-12",
        currency: "JPY",
        total: 1234,
        netSales: 1122,
        tax: 112,
        discounts: 10,
        vipPointsUsed: 0,
        refundTotal: 50,
        orderCount: 3,
        refundCount: 1,
        itemCount: 5,
        voucherChangeAmount: 0,
        paymentSectionsJson: JSON.stringify([
          { gateway: "cash", label: "現金", net: 1000, refund: 50, txCount: 2, refundCount: 1 },
        ]),
      },
      "本店",
    );
    assert.equal(preview.total, 1234);
    assert.equal(preview.locationName, "本店");
    assert.equal(preview.paymentSections[0].net, 1000);
    assert.equal(preview.paymentSections[0].refund, 50);
  });

  it("rebuilds reprint preview from snapshot envelope sections", () => {
    const preview = settlementRowToPreviewDTO(
      {
        locationId: "gid://shopify/Location/1",
        targetDate: "2026-11-12",
        currency: "JPY",
        total: 1234,
        netSales: 1122,
        tax: 112,
        discounts: 10,
        vipPointsUsed: 0,
        refundTotal: 50,
        orderCount: 3,
        refundCount: 1,
        itemCount: 5,
        voucherChangeAmount: 0,
        paymentSectionsJson: JSON.stringify({
          format: "settlement_print_v1",
          snapshot: {
            formVersion: "settlement-receipt-v1",
            locationName: "発行時店名",
            title: "【精算レシート】",
            isInspection: false,
          },
          sections: [
            { gateway: "cash", label: "現金", net: 1000, refund: 50, txCount: 2, refundCount: 1 },
          ],
        }),
      },
      "いまの店名",
    );
    assert.equal(preview.paymentSections[0].net, 1000);
    assert.equal(preview.paymentSections[0].label, "現金");
  });

  it("labels legacy stored printMode as unused for output", () => {
    assert.match(displayPrintModeLabel("order_based"), /未使用/);
    assert.equal(displayPrintModeLabel("shopify_printing"), "Shopify Printing API");
  });
});

describe("print path source guards", () => {
  it("create/recalculate never import Shopify settlement order sync", () => {
    const createSrc = readFileSync(join(root, "app/routes/api.settlements.create.tsx"), "utf8");
    const recalcSrc = readFileSync(join(root, "app/routes/api.settlements.recalculate.tsx"), "utf8");
    const reprintSrc = readFileSync(join(root, "app/routes/api.print.settlement.$id.tsx"), "utf8");
    for (const src of [createSrc, recalcSrc, reprintSrc]) {
      assert.doesNotMatch(src, /syncSettlementOrderLikeGas/);
      assert.doesNotMatch(src, /syncInspectionOrderLikeGas/);
      assert.doesNotMatch(src, /settlementOrderGas/);
    }
    assert.doesNotMatch(reprintSrc, /prisma\.settlement\.create/);
  });

  it("POS print helper does not treat disconnected printers as direct success", () => {
    const src = readFileSync(join(root, "extensions/common/printApi.js"), "utf8");
    assert.doesNotMatch(src, /list\.find\(\(p\) => p\?\.connected\) \?\? list\[0\]/);
    assert.match(src, /allowDialog/);
    assert.match(src, /PRINT_TIMEOUT/);
  });
});
