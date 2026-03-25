/**
 * ショップタイムゾーンと日次集計用 UTC 範囲
 * GAS_vs_APP_IMPLEMENTATION_GAP.md §5: Shopify の shop.ianaTimezone で「その日」の境界を算出
 */
import { getAppSetting } from "./appSettings.server";
import { GENERAL_SETTINGS_KEY } from "./appSettings.server";

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

const SHOP_TIMEZONE_QUERY = `#graphql
  query ShopTimezone { shop { ianaTimezone } }
`;

const FALLBACK_TIMEZONE = "Asia/Tokyo";

/**
 * 日次集計に使うタイムゾーンを取得する。
 * 1) Shopify の shop.ianaTimezone、2) 一般設定の defaultTimezone、3) Asia/Tokyo の順でフォールバック。
 */
export async function getShopTimezoneForDaily(
  admin: AdminClient,
  shopId: string
): Promise<string> {
  const fromShop = await getShopIanaTimezone(admin);
  if (fromShop) return fromShop;
  const general = await getAppSetting<{ defaultTimezone?: string }>(shopId, GENERAL_SETTINGS_KEY);
  return general?.defaultTimezone?.trim() || FALLBACK_TIMEZONE;
}

/**
 * Shopify のショップ設定から IANA タイムゾーンを取得する。
 * 取得できない場合は null を返す（呼び出し側で defaultTimezone にフォールバックすること）
 */
export async function getShopIanaTimezone(
  admin: AdminClient
): Promise<string | null> {
  try {
    const res = await admin.graphql(SHOP_TIMEZONE_QUERY);
    const json = await res.json() as { data?: { shop?: { ianaTimezone?: string } } };
    const tz = json.data?.shop?.ianaTimezone;
    return typeof tz === "string" && tz.trim() ? tz.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 指定日の「現地 00:00:00.000」が UTC で何時になるかを返す（Date）
 * @param dateStr YYYY-MM-DD
 * @param ianaTimezone IANA タイムゾーン（例: Asia/Tokyo）
 */
function getDayStartUtc(dateStr: string, ianaTimezone: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) {
    // 不正な日付の場合は UTC でその日 0:00 として扱う（フォールバック）
    return new Date(Date.UTC(y || 2000, (m || 1) - 1, d || 1, 0, 0, 0, 0));
  }
  // その日の正午 UTC を基準に、指定タイムゾーンでのオフセット（分）を取得
  const refUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: ianaTimezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(refUtc);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 12);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const second = Number(parts.find((p) => p.type === "second")?.value ?? 0);
  // 正午 UTC のときの現地時刻 → オフセット（分） = (現地 - 12:00) を逆に
  const offsetMinutes = (hour - 12) * 60 + minute + second / 60;
  // 現地 00:00:00 = UTC 00:00:00 - offsetMinutes
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - offsetMinutes * 60 * 1000);
}

/**
 * 指定日の「現地 23:59:59.999」が UTC で何時になるかを返す（Date）
 * 翌日 00:00:00.000 の 1ms 前として計算（DST 対応）
 */
function getDayEndUtc(dateStr: string, ianaTimezone: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) {
    const start = getDayStartUtc(dateStr, ianaTimezone);
    return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  const nextDay = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0));
  const nextDateStr = `${nextDay.getUTCFullYear()}-${String(nextDay.getUTCMonth() + 1).padStart(2, "0")}-${String(nextDay.getUTCDate()).padStart(2, "0")}`;
  const startNext = getDayStartUtc(nextDateStr, ianaTimezone);
  return new Date(startNext.getTime() - 1);
}

export interface DayRangeUtc {
  /** その日 00:00:00.000 現地 → UTC (ISO 文字列、created_at クエリ用) */
  startUtcIso: string;
  /** その日 23:59:59.999 現地 → UTC (ISO 文字列) */
  endUtcIso: string;
  startUtc: Date;
  endUtc: Date;
}

/**
 * 指定日付を指定タイムゾーンの「1日」とみなし、その範囲の UTC 開始・終了を返す。
 * Shopify の created_at クエリや Prisma の createdAt フィルタに使用する。
 */
export function getDayRangeInUtc(dateStr: string, ianaTimezone: string): DayRangeUtc {
  const startUtc = getDayStartUtc(dateStr, ianaTimezone);
  const endUtc = getDayEndUtc(dateStr, ianaTimezone);
  return {
    startUtcIso: startUtc.toISOString().replace(/\.000Z$/, "Z"),
    endUtcIso: endUtc.toISOString(),
    startUtc,
    endUtc,
  };
}

/**
 * 指定した瞬間を、IANA タイムゾーン上の暦日 YYYY-MM-DD に変換する。
 * サーバが UTC のときでも店舗の「今日」と一致させる（売上サマリーの targetDate 既定・当日判定など）。
 */
export function getCalendarDateStringInTimeZone(date: Date, ianaTimezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: ianaTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

/** YYYY-MM-DD の暦日に整数日を加算（日次キーの前後関係・前日比用） */
export function addCalendarDaysToIsoDate(isoDate: string, deltaDays: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + deltaDays);
  const yy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(base.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
