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

/**
 * 精算の locationId は GID と数値のどちらでも保存される。
 * 月次行 API と同じく、検索と表示名の解決では両方を対象にする。
 */
export function locationIdCandidates(locationId: string): string[] {
  const trimmed = locationId.trim();
  if (!trimmed) return [];
  const gid = trimmed.startsWith("gid://")
    ? trimmed
    : `gid://shopify/Location/${trimmed}`;
  const raw = gid.startsWith("gid://shopify/Location/")
    ? gid.slice("gid://shopify/Location/".length)
    : "";
  return raw && raw !== gid ? [gid, raw] : [gid];
}

export function findSettlementLocation<T extends { shopifyLocationGid: string }>(
  locations: readonly T[],
  storedLocationId: string,
): T | undefined {
  const wanted = new Set(locationIdCandidates(storedLocationId));
  return locations.find((row) =>
    locationIdCandidates(row.shopifyLocationGid).some((id) => wanted.has(id)),
  );
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

const EXECUTED_AT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

export function formatExecutedAt(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("ja-JP", { ...EXECUTED_AT_OPTIONS, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("ja-JP", {
      ...EXECUTED_AT_OPTIONS,
      timeZone: "Asia/Tokyo",
    }).format(date);
  }
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
    ...(filter.locationId
      ? { locationId: { in: locationIdCandidates(filter.locationId) } }
      : {}),
    ...kindWhere,
  };
}

/** 照合用 CSV（`/api/settlements/export-csv`）の対象期間の上限。サーバー側の SETTLEMENT_CSV_MAX_DAYS と同じ値。 */
export const SETTLEMENT_CSV_EXPORT_MAX_DAYS = 366;

export type SettlementCsvExportRequest =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * 精算履歴の絞り込みから、照合用 CSV の取得先を作る。
 * CSV は開始日と終了日の両方が要る。区分（点検）は CSV 側で常に除くので渡さない。
 */
export function buildSettlementCsvExportRequest(filter: {
  dateFrom: string;
  dateTo: string;
  locationId: string;
}): SettlementCsvExportRequest {
  const dateFrom = normalizeHistoryDate(filter.dateFrom);
  const dateTo = normalizeHistoryDate(filter.dateTo);
  if (!dateFrom || !dateTo) {
    return { ok: false, reason: "開始日と終了日を入れると書き出せます。" };
  }
  const days =
    Math.round(
      (Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86_400_000,
    ) + 1;
  if (!Number.isFinite(days) || days < 1) {
    return { ok: false, reason: "開始日を終了日より前にすると書き出せます。" };
  }
  if (days > SETTLEMENT_CSV_EXPORT_MAX_DAYS) {
    return {
      ok: false,
      reason: `書き出せるのは ${SETTLEMENT_CSV_EXPORT_MAX_DAYS} 日までです。期間を短くしてください。`,
    };
  }
  const params = new URLSearchParams({ dateFrom, dateTo });
  const locationId = filter.locationId.trim();
  if (locationId) params.set("locationId", locationId);
  return { ok: true, path: `/api/settlements/export-csv?${params.toString()}` };
}

/** Content-Disposition から保存するファイル名を取る（filename* を優先）。取れなければ fallback。 */
export function csvFilenameFromDisposition(header: string | null | undefined, fallback: string): string {
  const text = header ?? "";
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(text);
  if (star) {
    try {
      const decoded = decodeURIComponent(star[1].trim());
      if (decoded) return decoded;
    } catch {
      // 壊れた filename* は filename にまかせる
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"/i.exec(text) ?? /filename\s*=\s*([^;]+)/i.exec(text);
  const name = plain?.[1]?.trim();
  return name || fallback;
}
