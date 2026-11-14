import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RECEIPT_PRINT_FORM_VERSION,
  encodeReceiptPrintSnapshot,
  parseReceiptPrintSnapshot,
  resolveReceiptPrintSnapshot,
} from "./receiptPrintSnapshot.server";

describe("receipt print snapshot", () => {
  it("keeps issued company fields, visibility flags, and location after settings change", () => {
    const encoded = encodeReceiptPrintSnapshot({
      locationName: "発行時店舗",
      templateData: {
        companyName: "発行時会社",
        address: "発行時住所",
        phone: "00-0000-0000",
        showOrderNumber: false,
        showDate: true,
      },
      renderedHtmlByPaperWidth: {
        58: "<html>issued-58</html>",
        80: "<html>issued-80</html>",
      },
    });

    const resolved = resolveReceiptPrintSnapshot(encoded, {
      locationName: "変更後店舗",
      templateData: {
        companyName: "変更後会社",
        address: "変更後住所",
        phone: "99-9999-9999",
        showOrderNumber: true,
        showDate: false,
      },
    });

    assert.equal(resolved.snapshotPresent, true);
    assert.equal(resolved.formVersion, RECEIPT_PRINT_FORM_VERSION);
    assert.equal(resolved.locationName, "発行時店舗");
    assert.equal(resolved.templateData.companyName, "発行時会社");
    assert.equal(resolved.templateData.address, "発行時住所");
    assert.equal(resolved.templateData.phone, "00-0000-0000");
    assert.equal(resolved.templateData.showOrderNumber, false);
    assert.equal(resolved.templateData.showDate, true);
    assert.equal(resolved.renderedHtmlByPaperWidth?.[58], "<html>issued-58</html>");
    assert.equal(resolved.renderedHtmlByPaperWidth?.[80], "<html>issued-80</html>");
  });

  it("uses a legacy fallback only when no snapshot exists", () => {
    const fallback = {
      locationName: "現在店舗",
      templateData: { companyName: "現在会社" },
    };
    const resolved = resolveReceiptPrintSnapshot(null, fallback);
    assert.equal(resolved.snapshotPresent, false);
    assert.equal(resolved.snapshotUnreadable, false);
    assert.equal(resolved.locationName, "現在店舗");
    assert.equal(resolved.templateData.companyName, "現在会社");
    assert.equal(resolved.renderedHtmlByPaperWidth, null);
  });

  it("fails closed instead of silently using live settings for an unreadable snapshot", () => {
    const fallback = {
      locationName: "現在店舗",
      templateData: { companyName: "現在会社" },
    };
    const emptyHtml = encodeReceiptPrintSnapshot({
      locationName: "発行時店舗",
      templateData: { companyName: "発行時会社" },
      renderedHtmlByPaperWidth: { 58: "stored-58", 80: "stored-80" },
    }).replace("stored-58", "");
    for (const raw of ["not-json", JSON.stringify({ format: "future-v2" }), emptyHtml]) {
      const resolved = resolveReceiptPrintSnapshot(raw, fallback);
      assert.equal(resolved.snapshotPresent, false);
      assert.equal(resolved.snapshotUnreadable, true);
      assert.equal(resolved.renderedHtmlByPaperWidth, null);
    }
    assert.equal(parseReceiptPrintSnapshot("{}"), null);
  });

  it("keeps stored HTML usable when the form version advances", () => {
    const raw = encodeReceiptPrintSnapshot({
      locationName: "発行時店舗",
      templateData: { companyName: "発行時会社" },
      renderedHtmlByPaperWidth: { 58: "old-58", 80: "old-80" },
    }).replace(RECEIPT_PRINT_FORM_VERSION, "receipt-v2");
    const parsed = parseReceiptPrintSnapshot(raw);
    assert.equal(parsed?.formVersion, "receipt-v2");
    assert.equal(parsed?.renderedHtmlByPaperWidth[58], "old-58");
    assert.equal(parsed?.renderedHtmlByPaperWidth[80], "old-80");
  });
});
