/**
 * 照合用 CSV（保存済み精算 × 店舗・日・支払方法）の純関数。
 *
 * - DB に保存済みの Settlement 行だけを使い、Shopify からの再集計はしない。
 * - 点検（periodLabel が「点検_」で始まる行）は金額 0 で保存されるため出さない。
 * - 同じ店舗・同じ日に精算が複数あるときは、作成日時が最も新しい 1 件を使う
 *   （POS 精算モーダルの月内一覧 api.settlements.month-rows と同じ選び方）。
 * - 区分「支払方法」の行は paymentSectionsJson を 1 支払方法 = 1 行で出す。
 *   区分「精算合計」の行は保存済みの合計値（total / refundTotal / 税・割引など）を出す。
 */
import { parsePaymentSectionsJson } from "./settlementPrintSnapshot.server";

export interface SettlementCsvSourceRow {
  id: string;
  locationId: string;
  targetDate: string;
  periodLabel: string | null;
  currency: string | null;
  total: { toString(): string } | number | string;
  netSales: { toString(): string } | number | string;
  tax: { toString(): string } | number | string;
  discounts: { toString(): string } | number | string;
  vipPointsUsed: { toString(): string } | number | string;
  refundTotal: { toString(): string } | number | string;
  orderCount: number;
  refundCount: number;
  voucherChangeAmount: { toString(): string } | number | string;
  paymentSectionsJson: string;
  status: string;
  createdAt: Date;
}

export interface SettlementCsvOptions {
  dateFrom: string;
  dateTo: string;
  timezone: string;
  /** GID または数値 ID → 表示名 */
  locationNames: Map<string, string>;
  /** GID → 並び順（ロケーション設定の sortOrder。小さいほど先） */
  locationSortOrder?: Map<string, number>;
  /** 出力対象を絞ったロケーション（空なら全店舗） */
  locationFilterLabel: string;
  generatedAt: Date;
}

export interface SettlementCsvResult {
  csv: string;
  settlementCount: number;
  rowCount: number;
  skippedInspectionCount: number;
  skippedSupersededCount: number;
  skippedStatusCount: number;
}

/** CSV に出す精算の状態 */
export const SETTLEMENT_CSV_STATUSES = ["completed", "printed"] as const;

export const SETTLEMENT_CSV_MAX_DAYS = 366;

export const SETTLEMENT_CSV_COLUMNS = [
  "対象日",
  "ロケーションID",
  "ロケーション名",
  "区分",
  "支払方法",
  "支払方法コード",
  "売上",
  "返金",
  "差引",
  "取引件数",
  "返金件数",
  "税抜売上",
  "消費税",
  "割引",
  "ポイント利用",
  "商品券釣銭",
  "通貨",
  "精算ID",
  "精算日時",
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidYmd(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 両端を含む日数。不正な日付は NaN */
export function countDaysInclusive(dateFrom: string, dateTo: string): number {
  const a = Date.parse(`${dateFrom}T00:00:00Z`);
  const b = Date.parse(`${dateTo}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

export function toLocationGid(id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/Location/${id}`;
}

export function toLocationNumericId(id: string): string {
  return id.replace("gid://shopify/Location/", "");
}

export function isInspectionSettlement(periodLabel: string | null | undefined): boolean {
  return periodLabel?.startsWith("点検_") ?? false;
}

/** 表計算ソフトの数式として解釈されないよう、文字列セルの先頭記号を無害化する */
function neutralizeFormula(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function escapeCsvCell(value: string | number | null | undefined, opts?: { text?: boolean }): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (opts?.text) s = neutralizeFormula(s);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function amount(v: { toString(): string } | number | string): string {
  const s = String(v ?? "0");
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : "0";
}

interface ParsedSection {
  gateway: string;
  label: string;
  net: number;
  refund: number;
  txCount: number;
  refundCount: number;
}

/**
 * 保存した支払方法の行を読む。#22 のあとの新しい形（{ format, snapshot, sections }）も、前の配列の形も読む。
 * 読み方は印字と同じ parsePaymentSectionsJson に任せる（形が増えても CSV だけ取り残されない）。
 */
export function parsePaymentSections(json: string): ParsedSection[] {
  return parsePaymentSectionsJson(json).sections.map((s) => ({
    gateway: s.gateway,
    label: s.label || s.gateway,
    net: Number(s.net) || 0,
    refund: Number(s.refund) || 0,
    txCount: Number(s.txCount) || 0,
    refundCount: Number(s.refundCount) || 0,
  }));
}

/** 店舗 × 日ごとに、点検を除いた最新の精算 1 件を選ぶ */
export function selectLatestSettlements<T extends SettlementCsvSourceRow>(rows: T[]): {
  selected: T[];
  skippedInspectionCount: number;
  skippedSupersededCount: number;
  skippedStatusCount: number;
} {
  const byKey = new Map<string, T>();
  let skippedInspectionCount = 0;
  let skippedStatusCount = 0;
  let eligible = 0;
  for (const r of rows) {
    if (isInspectionSettlement(r.periodLabel)) {
      skippedInspectionCount++;
      continue;
    }
    if (!(SETTLEMENT_CSV_STATUSES as readonly string[]).includes(r.status)) {
      skippedStatusCount++;
      continue;
    }
    eligible++;
    const key = `${toLocationGid(r.locationId)}|${r.targetDate}`;
    const prev = byKey.get(key);
    if (!prev || r.createdAt.getTime() > prev.createdAt.getTime()) byKey.set(key, r);
  }
  const selected = [...byKey.values()];
  return {
    selected,
    skippedInspectionCount,
    skippedSupersededCount: eligible - selected.length,
    skippedStatusCount,
  };
}

function locationName(map: Map<string, string>, locationId: string): string {
  return map.get(toLocationGid(locationId)) ?? map.get(toLocationNumericId(locationId)) ?? "";
}

/** 日時を対象タイムゾーンで「YYYY-MM-DD HH:mm:ss」にする */
export function formatDateTimeInTz(d: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
  } catch {
    return d.toISOString();
  }
}

export function buildSettlementCsv(
  rows: SettlementCsvSourceRow[],
  opts: SettlementCsvOptions,
): SettlementCsvResult {
  const pick = selectLatestSettlements(rows);
  const selected = [...pick.selected].sort((a, b) => {
    if (a.targetDate !== b.targetDate) return a.targetDate < b.targetDate ? -1 : 1;
    const oa = opts.locationSortOrder?.get(toLocationGid(a.locationId)) ?? Number.MAX_SAFE_INTEGER;
    const ob = opts.locationSortOrder?.get(toLocationGid(b.locationId)) ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    const la = locationName(opts.locationNames, a.locationId) || toLocationNumericId(a.locationId);
    const lb = locationName(opts.locationNames, b.locationId) || toLocationNumericId(b.locationId);
    return la.localeCompare(lb, "ja");
  });

  const currencies = [...new Set(selected.map((s) => s.currency || "").filter(Boolean))];

  const notes = [
    "# POS Receipt 照合用CSV（保存済みの精算から出力。Shopify からの再集計はしていません）",
    `# 対象期間: ${opts.dateFrom} 〜 ${opts.dateTo}（精算の対象日。両端を含む）`,
    `# タイムゾーン: ${opts.timezone}（精算日時と出力日時はこのタイムゾーン。対象日は精算したときの日付のまま）`,
    `# 通貨: ${currencies.length ? currencies.join(" / ") : "（該当なし）"}（金額は通貨の単位。精算は整数に丸めて保存）`,
    `# 店舗: ${opts.locationFilterLabel}`,
    "# 区分: 支払方法=支払方法ごとの売上・返金・差引（差引=売上-返金） / 精算合計=その日の精算に保存された合計（差引=精算合計、税抜売上・消費税・割引・ポイント利用・商品券釣銭）",
    "# 1 店舗 1 日に精算が複数あるときは最新の 1 件だけを出します。点検は出しません。",
    `# 精算 ${selected.length} 件（点検 ${pick.skippedInspectionCount} 件・古い精算 ${pick.skippedSupersededCount} 件・未確定 ${pick.skippedStatusCount} 件は除外）`,
    `# 出力日時: ${formatDateTimeInTz(opts.generatedAt, opts.timezone)}`,
  ];

  const lines: string[] = notes.map((n) => escapeCsvCell(n, { text: false }));
  lines.push(SETTLEMENT_CSV_COLUMNS.join(","));

  let rowCount = 0;
  for (const s of selected) {
    const locId = toLocationNumericId(s.locationId);
    const locName = locationName(opts.locationNames, s.locationId);
    const createdAt = formatDateTimeInTz(s.createdAt, opts.timezone);
    const currency = s.currency || "";
    const sections = parsePaymentSections(s.paymentSectionsJson);

    const common = (kind: string) => [
      escapeCsvCell(s.targetDate),
      escapeCsvCell(locId),
      escapeCsvCell(locName, { text: true }),
      escapeCsvCell(kind),
    ];
    const tail = [escapeCsvCell(currency, { text: true }), escapeCsvCell(s.id), escapeCsvCell(createdAt)];

    for (const sec of sections) {
      lines.push(
        [
          ...common("支払方法"),
          escapeCsvCell(sec.label, { text: true }),
          escapeCsvCell(sec.gateway, { text: true }),
          String(sec.net),
          String(sec.refund),
          String(sec.net - sec.refund),
          String(sec.txCount),
          String(sec.refundCount),
          "",
          "",
          "",
          "",
          "",
          ...tail,
        ].join(","),
      );
      rowCount++;
    }

    const salesSum = sections.reduce((sum, sec) => sum + sec.net, 0);
    lines.push(
      [
        ...common("精算合計"),
        "",
        "",
        String(salesSum),
        amount(s.refundTotal),
        amount(s.total),
        String(s.orderCount),
        String(s.refundCount),
        amount(s.netSales),
        amount(s.tax),
        amount(s.discounts),
        amount(s.vipPointsUsed),
        amount(s.voucherChangeAmount),
        ...tail,
      ].join(","),
    );
    rowCount++;
  }

  // Excel で日本語が崩れないよう BOM 付き・CRLF
  return {
    csv: `﻿${lines.join("\r\n")}\r\n`,
    settlementCount: selected.length,
    rowCount,
    skippedInspectionCount: pick.skippedInspectionCount,
    skippedSupersededCount: pick.skippedSupersededCount,
    skippedStatusCount: pick.skippedStatusCount,
  };
}
