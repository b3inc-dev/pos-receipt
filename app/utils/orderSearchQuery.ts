/**
 * 注文を探す API（/api/orders/search）の Shopify の検索文。
 * 日の区切りは店のタイムゾーンの 0 時（日本の店は +09:00）。
 */
import { getDayRangeInUtc } from "./shopTimezone.server";

export function normalizeLocationIdForQuery(locationId: string | null | undefined): string | null {
  const s = locationId?.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/Location\/(\d+)$/) ?? s.match(/\/(\d+)$/);
  return m?.[1] ?? null;
}

export function buildSearchQuery(params: {
  q?: string | null;
  locationId?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  /** 店のタイムゾーン。日の区切りをその 0 時にする（無ければ UTC。前の動き） */
  timezone?: string | null;
}): string | undefined {
  const parts: string[] = [];
  if (params.q?.trim()) {
    const term = params.q.trim().replace(/^#/, "");
    if (/^\d+$/.test(term)) {
      parts.push(`name:${term}`);
    } else {
      parts.push(params.q.trim());
    }
  }
  const locIdRaw = normalizeLocationIdForQuery(params.locationId);
  if (locIdRaw) {
    parts.push(`location_id:${locIdRaw}`);
    parts.push("source_name:pos");
  }
  // 検索語があるときは日付条件を付けない（店舗内の過去注文を横断検索）
  const hasQuery = Boolean(params.q?.trim());
  if (!hasQuery) {
    // 日の区切りは店のタイムゾーンの 0 時。前は UTC の 0 時で、0〜9 時の注文が前の日に出ていた。
    // 書き方は UTC の Z 表記にする（精算の注文検索 settlementEngine と同じ）。
    // 「2026-11-23T00:00:00+09:00」の形では、開発ストアの POS で 1 件も出なかった（2026-11-23 実機）。
    const tz = params.timezone?.trim();
    if (params.dateFrom) {
      const start = tz ? getDayRangeInUtc(params.dateFrom, tz).startUtcIso : `${params.dateFrom}T00:00:00Z`;
      parts.push(`created_at:>=${start}`);
    }
    if (params.dateTo) {
      const end = tz ? getDayRangeInUtc(params.dateTo, tz).endUtcIso : `${params.dateTo}T23:59:59Z`;
      parts.push(`created_at:<=${end}`);
    }
  }
  if (parts.length === 0) return undefined;
  return parts.join(" AND ");
}
