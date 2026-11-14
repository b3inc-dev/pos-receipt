export const RECEIPT_PRINT_SNAPSHOT_FORMAT = "receipt-print-snapshot-v1";
export const RECEIPT_PRINT_FORM_VERSION = "receipt-v1";

export type ReceiptPrintSnapshot = {
  format: typeof RECEIPT_PRINT_SNAPSHOT_FORMAT;
  formVersion: typeof RECEIPT_PRINT_FORM_VERSION;
  locationName: string;
  templateData: Record<string, unknown>;
};

export function encodeReceiptPrintSnapshot(input: {
  locationName: string;
  templateData: Record<string, unknown>;
}): string {
  const snapshot: ReceiptPrintSnapshot = {
    format: RECEIPT_PRINT_SNAPSHOT_FORMAT,
    formVersion: RECEIPT_PRINT_FORM_VERSION,
    locationName: String(input.locationName ?? ""),
    templateData: { ...input.templateData },
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
      parsed.formVersion !== RECEIPT_PRINT_FORM_VERSION ||
      !parsed.templateData ||
      typeof parsed.templateData !== "object" ||
      Array.isArray(parsed.templateData)
    ) {
      return null;
    }
    return {
      format: RECEIPT_PRINT_SNAPSHOT_FORMAT,
      formVersion: RECEIPT_PRINT_FORM_VERSION,
      locationName: String(parsed.locationName ?? ""),
      templateData: { ...parsed.templateData },
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
  formVersion: string | null;
  locationName: string;
  templateData: Record<string, unknown>;
} {
  const snapshot = parseReceiptPrintSnapshot(raw);
  if (!snapshot) {
    return {
      snapshotPresent: false,
      formVersion: null,
      locationName: fallback.locationName,
      templateData: { ...fallback.templateData },
    };
  }
  return {
    snapshotPresent: true,
    formVersion: snapshot.formVersion,
    locationName: snapshot.locationName,
    templateData: { ...snapshot.templateData },
  };
}
