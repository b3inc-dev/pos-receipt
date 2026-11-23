import { renderPrintReceiptHtml } from "./printReceiptHtml";

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

/** 領収書の 1 行（ReceiptIssue）のうち、紙面を作るのに使う値 */
export type ReceiptIssueForPrint = {
  recipientName: string | null;
  proviso: string | null;
  amount: number | string | { toString(): string };
  currency: string | null;
  createdAt: Date;
  orderName: string | null;
};

/** 発行時と同じ形で、58mm・80mm の領収書 HTML を作る（発行と、削除の依頼での作り直しで共通） */
export function renderReceiptHtmlByPaperWidth(
  row: ReceiptIssueForPrint,
  locationName: string,
  templateData: Record<string, unknown>,
): { 58: string; 80: string } {
  const t = templateData as {
    companyName?: string;
    address?: string;
    phone?: string;
    defaultProviso?: string;
    showOrderNumber?: boolean;
    showOrderName?: boolean;
    showDate?: boolean;
    showIssueDate?: boolean;
  };
  const model = {
    kind: "receipt" as const,
    title: "領　収　書",
    recipientName: row.recipientName ?? "",
    proviso: row.proviso ?? t.defaultProviso ?? "お買上品代として",
    amount: Number(String(row.amount)),
    currency: row.currency ?? "JPY",
    issueDate: row.createdAt.toISOString().slice(0, 10),
    orderName: row.orderName ?? undefined,
    locationName,
    companyName: t.companyName ?? "",
    address: t.address ?? "",
    phone: t.phone ?? "",
    showOrderNumber: Boolean(t.showOrderNumber ?? t.showOrderName),
    showDate: Boolean(t.showDate ?? t.showIssueDate),
  };
  return {
    58: renderPrintReceiptHtml({ ...model, paperWidthMm: 58 }),
    80: renderPrintReceiptHtml({ ...model, paperWidthMm: 80 }),
  };
}

/** 削除の依頼（customers/redact）のあとに、宛名の列へ入れる値 */
export const REDACTED_RECIPIENT_NAME = "[redacted]";

/**
 * 削除の依頼で、保存した発行時の紙面から宛名を抜く。
 * - 読める紙面: 発行時の会社・店・表示の設定のまま、宛名を空にして 58mm・80mm を作り直す
 * - 無い・読めない紙面: null（宛名入りの HTML を残さない。刷り直しは今の設定で作り直す道になり、宛名は列の値）
 */
export function redactReceiptPrintSnapshot(
  raw: string | null | undefined,
  row: ReceiptIssueForPrint,
): string | null {
  const snapshot = parseReceiptPrintSnapshot(raw);
  if (!snapshot) return null;
  return encodeReceiptPrintSnapshot({
    locationName: snapshot.locationName,
    templateData: snapshot.templateData,
    renderedHtmlByPaperWidth: renderReceiptHtmlByPaperWidth(
      { ...row, recipientName: "" },
      snapshot.locationName,
      snapshot.templateData,
    ),
  });
}
