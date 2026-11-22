/**
 * 精算・点検レシートの表示スナップショット。
 * 金額・店舗表示名・表題・帳票版は発行時に保存し、再印刷で現在の店舗名に置き換えない。
 * 用紙幅は帳票内容ではなく出力機器の都合として、再印刷時の設定を使う。
 */
import {
  renderPrintReceiptHtml,
  settlementPreviewToPrintModel,
  type SettlementReceiptPrintModel,
} from "./printReceiptHtml";
import {
  settlementRowToPreviewDTO,
  type SettlementRowLike,
} from "./printUnification.server";

export const SETTLEMENT_RECEIPT_FORM_VERSION = "settlement-receipt-v1";
export const SETTLEMENT_PRINT_ENVELOPE_FORMAT = "settlement_print_v1";

export type SettlementPaymentSection = {
  gateway: string;
  label: string;
  net: number;
  refund: number;
  txCount: number;
  refundCount: number;
};

export type SettlementPrintSnapshot = {
  formVersion: string;
  locationName: string;
  title: string;
  isInspection: boolean;
};

export type ParsedSettlementPrintPayload = {
  sections: SettlementPaymentSection[];
  snapshot: SettlementPrintSnapshot | null;
  legacyUnversioned: boolean;
};

export const LEGACY_SETTLEMENT_UNRESTORED_FIELDS = [
  "locationName",
  "title",
  "formVersion",
] as const;

export function settlementReceiptTitle(isInspection: boolean): string {
  return isInspection ? "【点検レシート】" : "【精算レシート】";
}

export function buildSettlementPrintSnapshot(opts: {
  locationName: string;
  isInspection: boolean;
}): SettlementPrintSnapshot {
  return {
    formVersion: SETTLEMENT_RECEIPT_FORM_VERSION,
    locationName: String(opts.locationName ?? "").trim(),
    title: settlementReceiptTitle(opts.isInspection),
    isInspection: !!opts.isInspection,
  };
}

function normalizeSection(s: Record<string, unknown>): SettlementPaymentSection {
  return {
    gateway: String(s.gateway ?? s.label ?? ""),
    label: String(s.label ?? s.gateway ?? ""),
    net: Number(s.net ?? 0),
    refund: Number(s.refund ?? 0),
    txCount: Number(s.txCount ?? 0),
    refundCount: Number(s.refundCount ?? 0),
  };
}

export function encodePaymentSectionsJson(
  sections: Array<Record<string, unknown> | SettlementPaymentSection>,
  snapshot: SettlementPrintSnapshot,
): string {
  return JSON.stringify({
    format: SETTLEMENT_PRINT_ENVELOPE_FORMAT,
    snapshot,
    sections: sections.map((s) => normalizeSection(s as Record<string, unknown>)),
  });
}

export function parsePaymentSectionsJson(
  json: string | null | undefined,
): ParsedSettlementPrintPayload {
  if (!json) {
    return { sections: [], snapshot: null, legacyUnversioned: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { sections: [], snapshot: null, legacyUnversioned: true };
  }
  if (Array.isArray(parsed)) {
    return {
      sections: parsed.map((s) => normalizeSection((s ?? {}) as Record<string, unknown>)),
      snapshot: null,
      legacyUnversioned: true,
    };
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as {
      format?: string;
      snapshot?: Partial<SettlementPrintSnapshot>;
      sections?: unknown;
    };
    const sections = Array.isArray(obj.sections)
      ? obj.sections.map((s) => normalizeSection((s ?? {}) as Record<string, unknown>))
      : [];
    const snap = obj.snapshot;
    const snapshot: SettlementPrintSnapshot | null =
      snap && typeof snap.locationName === "string"
        ? {
            formVersion: String(snap.formVersion ?? ""),
            locationName: snap.locationName,
            title: String(snap.title ?? ""),
            isInspection: !!snap.isInspection,
          }
        : null;
    return {
      sections,
      snapshot,
      legacyUnversioned: obj.format !== SETTLEMENT_PRINT_ENVELOPE_FORMAT || !snapshot,
    };
  }
  return { sections: [], snapshot: null, legacyUnversioned: true };
}

export function paymentSectionsForApi(json: string | null | undefined): SettlementPaymentSection[] {
  return parsePaymentSectionsJson(json).sections;
}

export type SettlementReprintResult = {
  html: string;
  model: SettlementReceiptPrintModel;
  formVersion: string | null;
  snapshotPresent: boolean;
  unrestoredFields: string[];
};

/** 再印刷。注文・精算行は作らない純関数。用紙幅は出力機器側。 */
export function buildSettlementReprintView(
  row: SettlementRowLike & { periodLabel?: string | null },
  opts: {
    currentLocationName: string;
    devicePaperWidthMm: 58 | 80;
  },
): SettlementReprintResult {
  const parsed = parsePaymentSectionsJson(row.paymentSectionsJson);
  const unrestoredFields: string[] = [];
  const snapshot = parsed.snapshot;
  if (!snapshot) {
    unrestoredFields.push(...LEGACY_SETTLEMENT_UNRESTORED_FIELDS);
  }

  const isInspection =
    snapshot?.isInspection ?? String(row.periodLabel ?? "").startsWith("点検");
  const locationName = snapshot?.locationName?.trim()
    ? snapshot.locationName
    : opts.currentLocationName;
  const title = snapshot?.title?.trim()
    ? snapshot.title
    : settlementReceiptTitle(isInspection);

  const preview = settlementRowToPreviewDTO(row, locationName);
  const model = settlementPreviewToPrintModel(preview, {
    isInspection,
    paperWidthMm: opts.devicePaperWidthMm,
    title,
  });
  return {
    html: renderPrintReceiptHtml(model),
    model,
    formVersion: snapshot?.formVersion || null,
    snapshotPresent: !!snapshot,
    unrestoredFields,
  };
}

export function reprintCreatesShopifyOrder(): false {
  return false;
}

export function reprintCreatesSettlementRow(): false {
  return false;
}
