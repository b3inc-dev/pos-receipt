/** 精算履歴の絞り込みと表示用。DB クライアントには依存しない。 */

export const INSPECTION_PERIOD_PREFIX = "点検_";

export type SettlementHistoryKind = "all" | "settlement" | "inspection";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeHistoryDate(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  return DATE_RE.test(text) ? text : "";
}

export function normalizeHistoryKind(value: string | null | undefined): SettlementHistoryKind {
  if (value === "settlement" || value === "inspection") return value;
  return "all";
}

export function normalizeHistoryPage(value: string | null | undefined): number {
  const parsed = Number(value ?? "1");
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.floor(parsed);
}

export function isInspectionPeriod(periodLabel: string | null | undefined): boolean {
  return typeof periodLabel === "string" && periodLabel.startsWith(INSPECTION_PERIOD_PREFIX);
}

export function settlementLocationLabel(
  location: { name?: string | null; displayName?: string | null } | undefined,
  locationId: string,
): { label: string; title: string } {
  const display = location?.displayName?.trim() ?? "";
  const name = location?.name?.trim() ?? "";
  if (display && name && display !== name) {
    return { label: display, title: `${display}（${name}）` };
  }
  if (display) return { label: display, title: display };
  if (name) return { label: name, title: name };
  return { label: "未登録のロケーション", title: locationId };
}

export function formatYen(value: string | number): string {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) return "—";
  return `¥${amount.toLocaleString("ja-JP")}`;
}

export function formatExecutedAt(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(date);
}

export function dateRangeWarning(dateFrom: string, dateTo: string): string | null {
  if (dateFrom && dateTo && dateFrom > dateTo) {
    return "開始日が終了日より後です。日付を入れ替えて絞り込んでください。";
  }
  return null;
}

export type SettlementHistoryFilter = {
  shopId: string;
  dateFrom: string;
  dateTo: string;
  locationId: string;
  kind: SettlementHistoryKind;
};

/** Prisma の where にそのまま渡せる形。null の periodLabel は精算として扱う。 */
export function buildSettlementHistoryWhere(filter: SettlementHistoryFilter) {
  const targetDate =
    filter.dateFrom || filter.dateTo
      ? {
          ...(filter.dateFrom ? { gte: filter.dateFrom } : {}),
          ...(filter.dateTo ? { lte: filter.dateTo } : {}),
        }
      : undefined;

  const kindWhere =
    filter.kind === "inspection"
      ? { periodLabel: { startsWith: INSPECTION_PERIOD_PREFIX } }
      : filter.kind === "settlement"
        ? {
            OR: [
              { periodLabel: null },
              { NOT: { periodLabel: { startsWith: INSPECTION_PERIOD_PREFIX } } },
            ],
          }
        : {};

  return {
    shopId: filter.shopId,
    ...(targetDate ? { targetDate } : {}),
    ...(filter.locationId ? { locationId: filter.locationId } : {}),
    ...kindWhere,
  };
}
