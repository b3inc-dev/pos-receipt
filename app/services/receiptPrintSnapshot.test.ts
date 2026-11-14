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
  });

  it("falls back for legacy, invalid, and unknown-version rows", () => {
    const fallback = {
      locationName: "現在店舗",
      templateData: { companyName: "現在会社" },
    };
    for (const raw of [null, "not-json", JSON.stringify({ format: "future-v2" })]) {
      const resolved = resolveReceiptPrintSnapshot(raw, fallback);
      assert.equal(resolved.snapshotPresent, false);
      assert.equal(resolved.locationName, "現在店舗");
      assert.equal(resolved.templateData.companyName, "現在会社");
    }
    assert.equal(parseReceiptPrintSnapshot("{}"), null);
  });
});
