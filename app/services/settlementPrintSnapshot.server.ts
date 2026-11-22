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

/**
 * 印字に出した金額（レイアウトの印字用）。点検は精算の行の金額を 0 で保存するので、
 * 点検レシートを出し直すときはここの値を使う。集計（履歴の合計・CSV）には使わない。
 */
export type SettlementPrintDisplay = {
  issuedAt: string;
  figures: {
    total: number;
    netSales: number;
    tax: number;
    discounts: number;
    vipPointsUsed: number;
    refundTotal: number;
    orderCount: number;
    refundCount: number;
    itemCount: number;
    voucherChangeAmount: number;
  };
  sections: SettlementPaymentSection[];
};

export type ParsedSettlementPrintPayload = {
  sections: SettlementPaymentSection[];
  snapshot: SettlementPrintSnapshot | null;
  legacyUnversioned: boolean;
  display: SettlementPrintDisplay | null;
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

const FIGURE_KEYS = [
  "total",
  "netSales",
  "tax",
  "discounts",
  "vipPointsUsed",
  "refundTotal",
  "orderCount",
  "refundCount",
  "itemCount",
  "voucherChangeAmount",
] as const;

function normalizeDisplay(raw: unknown): SettlementPrintDisplay | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as { issuedAt?: unknown; figures?: Record<string, unknown>; sections?: unknown };
  if (!d.figures || typeof d.figures !== "object") return null;
  const figures = Object.fromEntries(
    FIGURE_KEYS.map((k) => [k, Number(d.figures?.[k] ?? 0) || 0]),
  ) as SettlementPrintDisplay["figures"];
  return {
    issuedAt: String(d.issuedAt ?? ""),
    figures,
    sections: Array.isArray(d.sections)
      ? d.sections.map((s) => normalizeSection((s ?? {}) as Record<string, unknown>))
      : [],
  };
}

export function encodePaymentSectionsJson(
  sections: Array<Record<string, unknown> | SettlementPaymentSection>,
  snapshot: SettlementPrintSnapshot,
  display?: {
    issuedAt: string;
    figures: Record<string, unknown>;
    sections: Array<Record<string, unknown> | SettlementPaymentSection>;
  },
): string {
  return JSON.stringify({
    format: SETTLEMENT_PRINT_ENVELOPE_FORMAT,
    snapshot,
    sections: sections.map((s) => normalizeSection(s as Record<string, unknown>)),
    ...(display ? { display: normalizeDisplay(display) } : {}),
  });
}

export function parsePaymentSectionsJson(
  json: string | null | undefined,
): ParsedSettlementPrintPayload {
  if (!json) {
    return { sections: [], snapshot: null, legacyUnversioned: true, display: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { sections: [], snapshot: null, legacyUnversioned: true, display: null };
  }
  if (Array.isArray(parsed)) {
    return {
      sections: parsed.map((s) => normalizeSection((s ?? {}) as Record<string, unknown>)),
      snapshot: null,
      legacyUnversioned: true,
      display: null,
    };
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as {
      format?: string;
      snapshot?: Partial<SettlementPrintSnapshot>;
      sections?: unknown;
      display?: unknown;
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
      display: normalizeDisplay(obj.display),
    };
  }
  return { sections: [], snapshot: null, legacyUnversioned: true, display: null };
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

  // 点検は精算の行に 0 を保存する（集計に入れないため）。金額は発行時に保存した display から出す
  const printRow = settlementRowForPrint(row, parsed, isInspection);
  const preview = settlementRowToPreviewDTO(printRow, locationName);
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

/**
 * 印字に使う金額の行。精算は行の値のまま。点検で display があれば display の値（行は 0 なので）。
 * display の無い古い点検は行のまま（0）。
 */
export function settlementRowForPrint<T extends SettlementRowLike>(
  row: T,
  parsed: ParsedSettlementPrintPayload,
  isInspection: boolean,
): T {
  if (!isInspection || !parsed.display) return row;
  return {
    ...row,
    ...parsed.display.figures,
    paymentSectionsJson: JSON.stringify(parsed.display.sections),
  };
}

export function reprintCreatesShopifyOrder(): false {
  return false;
}

export function reprintCreatesSettlementRow(): false {
  return false;
}
