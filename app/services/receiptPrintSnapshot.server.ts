export const RECEIPT_PRINT_SNAPSHOT_FORMAT = "receipt-print-snapshot-v1";
export const RECEIPT_PRINT_FORM_VERSION = "receipt-v1";

export type ReceiptPrintSnapshot = {
  format: typeof RECEIPT_PRINT_SNAPSHOT_FORMAT;
  formVersion: string;
  locationName: string;
  templateData: Record<string, unknown>;
  renderedHtmlByPaperWidth: {
    58: string;
    80: string;
  };
};

export function encodeReceiptPrintSnapshot(input: {
  locationName: string;
  templateData: Record<string, unknown>;
  renderedHtmlByPaperWidth: { 58: string; 80: string };
}): string {
  const snapshot: ReceiptPrintSnapshot = {
    format: RECEIPT_PRINT_SNAPSHOT_FORMAT,
    formVersion: RECEIPT_PRINT_FORM_VERSION,
    locationName: String(input.locationName ?? ""),
    templateData: { ...input.templateData },
    renderedHtmlByPaperWidth: {
      58: String(input.renderedHtmlByPaperWidth[58] ?? ""),
      80: String(input.renderedHtmlByPaperWidth[80] ?? ""),
    },
  };
  return JSON.stringify(snapshot);
}

export function parseReceiptPrintSnapshot(
  raw: string | null | undefined,
): ReceiptPrintSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReceiptPrintSnapshot>;
    if (
      parsed.format !== RECEIPT_PRINT_SNAPSHOT_FORMAT ||
      typeof parsed.formVersion !== "string" ||
      !parsed.formVersion ||
      !parsed.templateData ||
      typeof parsed.templateData !== "object" ||
      Array.isArray(parsed.templateData) ||
      !parsed.renderedHtmlByPaperWidth ||
      typeof parsed.renderedHtmlByPaperWidth[58] !== "string" ||
      !parsed.renderedHtmlByPaperWidth[58].trim() ||
      typeof parsed.renderedHtmlByPaperWidth[80] !== "string" ||
      !parsed.renderedHtmlByPaperWidth[80].trim()
    ) {
      return null;
    }
    return {
      format: RECEIPT_PRINT_SNAPSHOT_FORMAT,
      formVersion: parsed.formVersion,
      locationName: String(parsed.locationName ?? ""),
      templateData: { ...parsed.templateData },
      renderedHtmlByPaperWidth: {
        58: parsed.renderedHtmlByPaperWidth[58],
        80: parsed.renderedHtmlByPaperWidth[80],
      },
    };
  } catch {
    return null;
  }
}

export function resolveReceiptPrintSnapshot(
  raw: string | null | undefined,
  fallback: { locationName: string; templateData: Record<string, unknown> },
): {
  snapshotPresent: boolean;
  snapshotUnreadable: boolean;
  formVersion: string | null;
  locationName: string;
  templateData: Record<string, unknown>;
  renderedHtmlByPaperWidth: { 58: string; 80: string } | null;
} {
  const snapshot = parseReceiptPrintSnapshot(raw);
  if (!snapshot) {
    return {
      snapshotPresent: false,
      snapshotUnreadable: Boolean(raw),
      formVersion: null,
      locationName: fallback.locationName,
      templateData: { ...fallback.templateData },
      renderedHtmlByPaperWidth: null,
    };
  }
  return {
    snapshotPresent: true,
    snapshotUnreadable: false,
    formVersion: snapshot.formVersion,
    locationName: snapshot.locationName,
    templateData: { ...snapshot.templateData },
    renderedHtmlByPaperWidth: { ...snapshot.renderedHtmlByPaperWidth },
  };
}
