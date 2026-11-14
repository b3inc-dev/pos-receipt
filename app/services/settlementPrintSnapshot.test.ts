import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  LEGACY_SETTLEMENT_UNRESTORED_FIELDS,
  SETTLEMENT_RECEIPT_FORM_VERSION,
  buildSettlementPrintSnapshot,
  buildSettlementReprintView,
  encodePaymentSectionsJson,
  parsePaymentSectionsJson,
  reprintCreatesSettlementRow,
  reprintCreatesShopifyOrder,
} from "./settlementPrintSnapshot.server";
import type { SettlementRowLike } from "./printUnification.server";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const ISSUED_NAME = "梅田店";
const RENAMED_NAME = "新梅田店";

function amounts() {
  return {
    locationId: "gid://shopify/Location/1",
    targetDate: "2026-11-12",
    currency: "JPY",
    total: 12340,
    netSales: 11218,
    tax: 1122,
    discounts: 50,
    vipPointsUsed: 0,
    refundTotal: 200,
    orderCount: 4,
    refundCount: 1,
    itemCount: 7,
    voucherChangeAmount: 0,
  };
}

function cashSection() {
  return {
    gateway: "cash",
    label: "現金",
    net: 12340,
    refund: 200,
    txCount: 4,
    refundCount: 1,
  };
}

function savedRow(opts: {
  isInspection: boolean;
  locationName: string;
}): SettlementRowLike & { periodLabel: string } {
  const snapshot = buildSettlementPrintSnapshot({
    locationName: opts.locationName,
    isInspection: opts.isInspection,
  });
  return {
    ...amounts(),
    total: opts.isInspection ? 0 : 12340,
    netSales: opts.isInspection ? 0 : 11218,
    tax: opts.isInspection ? 0 : 1122,
    discounts: opts.isInspection ? 0 : 50,
    refundTotal: opts.isInspection ? 0 : 200,
    orderCount: opts.isInspection ? 0 : 4,
    refundCount: opts.isInspection ? 0 : 1,
    itemCount: opts.isInspection ? 0 : 7,
    periodLabel: opts.isInspection ? "点検_2026-11-12" : "2026-11-12",
    paymentSectionsJson: encodePaymentSectionsJson(
      opts.isInspection ? [] : [cashSection()],
      snapshot,
    ),
  };
}

function contentFingerprint(html: string): string {
  // Paper width intentionally changes only the print shell/CSS. Compare the
  // issued receipt body so 80 -> 58 -> 80 cannot alter saved values or labels.
  return html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? html;
}

describe("settlement print snapshot encode/parse", () => {
  it("roundtrips envelope and keeps legacy arrays readable", () => {
    const snapshot = buildSettlementPrintSnapshot({
      locationName: ISSUED_NAME,
      isInspection: false,
    });
    const json = encodePaymentSectionsJson([cashSection()], snapshot);
    const parsed = parsePaymentSectionsJson(json);
    assert.equal(parsed.legacyUnversioned, false);
    assert.equal(parsed.snapshot?.formVersion, SETTLEMENT_RECEIPT_FORM_VERSION);
    assert.equal(parsed.snapshot?.locationName, ISSUED_NAME);
    assert.equal(parsed.snapshot?.title, "【精算レシート】");
    assert.equal(parsed.sections[0].label, "現金");
    assert.equal(parsed.sections[0].net, 12340);

    const legacy = parsePaymentSectionsJson(JSON.stringify([cashSection()]));
    assert.equal(legacy.legacyUnversioned, true);
    assert.equal(legacy.snapshot, null);
    assert.equal(legacy.sections[0].label, "現金");
  });
});

describe("synthetic first print vs reprint after settings change", () => {
  it("settlement reprint keeps issued store name, amounts, and form version after rename", () => {
    const row = savedRow({ isInspection: false, locationName: ISSUED_NAME });
    const first = buildSettlementReprintView(row, {
      currentLocationName: ISSUED_NAME,
      devicePaperWidthMm: 80,
    });
    const afterRename = buildSettlementReprintView(row, {
      currentLocationName: RENAMED_NAME,
      devicePaperWidthMm: 80,
    });

    assert.equal(first.snapshotPresent, true);
    assert.equal(first.formVersion, SETTLEMENT_RECEIPT_FORM_VERSION);
    assert.deepEqual(first.unrestoredFields, []);
    assert.equal(first.model.locationName, ISSUED_NAME);
    assert.equal(first.model.title, "【精算レシート】");
    assert.equal(first.model.total, 12340);
    assert.equal(first.model.paymentSections[0].label, "現金");
    assert.match(first.html, /梅田店/);
    assert.doesNotMatch(first.html, /新梅田店/);

    assert.equal(afterRename.html, first.html);
    assert.equal(afterRename.model.locationName, ISSUED_NAME);
    assert.equal(afterRename.model.total, first.model.total);
    assert.equal(afterRename.formVersion, first.formVersion);
    assert.doesNotMatch(afterRename.html, /新梅田店/);
  });

  it("inspection reprint keeps issued store name and inspection title after rename", () => {
    const row = savedRow({ isInspection: true, locationName: ISSUED_NAME });
    const first = buildSettlementReprintView(row, {
      currentLocationName: ISSUED_NAME,
      devicePaperWidthMm: 80,
    });
    const afterRename = buildSettlementReprintView(row, {
      currentLocationName: RENAMED_NAME,
      devicePaperWidthMm: 58,
    });

    assert.match(first.html, /点検レシート/);
    assert.doesNotMatch(first.html, /精算レシート/);
    assert.equal(first.model.locationName, ISSUED_NAME);
    assert.equal(first.model.total, 0);
    assert.equal(first.model.paymentSections.length, 0);
    assert.equal(afterRename.model.locationName, ISSUED_NAME);
    assert.equal(afterRename.model.title, first.model.title);
    assert.equal(afterRename.formVersion, SETTLEMENT_RECEIPT_FORM_VERSION);
    assert.doesNotMatch(afterRename.html, /新梅田店/);
    assert.equal(contentFingerprint(afterRename.html), contentFingerprint(first.html));
  });

  it("paper width is device-side: CSS may change, issued display content does not", () => {
    const row = savedRow({ isInspection: false, locationName: ISSUED_NAME });
    const at80 = buildSettlementReprintView(row, {
      currentLocationName: RENAMED_NAME,
      devicePaperWidthMm: 80,
    });
    const at58 = buildSettlementReprintView(row, {
      currentLocationName: RENAMED_NAME,
      devicePaperWidthMm: 58,
    });

    assert.equal(at80.model.paperWidthMm, 80);
    assert.equal(at58.model.paperWidthMm, 58);
    assert.match(at80.html, /width:\s*576px/);
    assert.match(at58.html, /width:\s*384px/);
    assert.equal(contentFingerprint(at80.html), contentFingerprint(at58.html));
    assert.equal(at80.model.locationName, ISSUED_NAME);
    assert.equal(at58.model.locationName, ISSUED_NAME);
    assert.equal(at80.model.total, at58.model.total);
    assert.equal(at80.model.title, at58.model.title);
  });

  it("legacy unversioned rows cannot restore issued store name or form version", () => {
    const legacy: SettlementRowLike & { periodLabel: string } = {
      ...amounts(),
      periodLabel: "2026-11-12",
      paymentSectionsJson: JSON.stringify([cashSection()]),
    };
    const reprint = buildSettlementReprintView(legacy, {
      currentLocationName: RENAMED_NAME,
      devicePaperWidthMm: 80,
    });
    assert.equal(reprint.snapshotPresent, false);
    assert.equal(reprint.formVersion, null);
    assert.deepEqual(
      reprint.unrestoredFields,
      [...LEGACY_SETTLEMENT_UNRESTORED_FIELDS],
    );
    assert.equal(reprint.model.locationName, RENAMED_NAME);
    assert.match(reprint.html, /新梅田店/);
    assert.equal(reprint.model.total, 12340);
    assert.equal(reprint.model.paymentSections[0].label, "現金");
  });
});

describe("reprint does not create orders or settlements", () => {
  it("reprint helpers are read-only", () => {
    assert.equal(reprintCreatesShopifyOrder(), false);
    assert.equal(reprintCreatesSettlementRow(), false);
  });

  it("print settlement route rebuilds HTML without Shopify order or Settlement create", () => {
    const printSrc = readFileSync(join(root, "app/routes/api.print.settlement.$id.tsx"), "utf8");
    const createSrc = readFileSync(join(root, "app/routes/api.settlements.create.tsx"), "utf8");
    assert.match(printSrc, /buildSettlementReprintView/);
    assert.doesNotMatch(printSrc, /settlementOrderGas/);
    assert.doesNotMatch(printSrc, /syncSettlementOrderLikeGas/);
    assert.doesNotMatch(printSrc, /syncInspectionOrderLikeGas/);
    assert.doesNotMatch(printSrc, /prisma\.settlement\.create/);
    assert.doesNotMatch(printSrc, /admin\.graphql/);
    assert.match(createSrc, /encodePaymentSectionsJson/);
    assert.match(createSrc, /buildSettlementPrintSnapshot/);
    assert.doesNotMatch(createSrc, /settlementOrderGas/);
  });
});
