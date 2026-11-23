/**
 * ショップタイムゾーンと日次集計用 UTC 範囲
 * 日次の「その日」は管理画面の一般設定（デフォルトタイムゾーン）を正とし、
 * 未保存時のみ Shopify の shop.ianaTimezone を使う（要件 §3 一般設定との整合）。
 */
import { getAppSetting, GENERAL_SETTINGS_KEY, type GeneralSettings } from "./appSettings.server";
import { adminGraphqlWithRetry } from "../lib/shopifyGraphqlThrottle.server";

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

const SHOP_TIMEZONE_QUERY = `#graphql
  query ShopTimezone { shop { ianaTimezone } }
`;

const FALLBACK_TIMEZONE = "Asia/Tokyo";

/**
 * 日次集計に使うタイムゾーンを取得する。
 * 1) 一般設定（general_settings）の defaultTimezone（保存済みなら必ずこれを優先）
 * 2) Shopify の shop.ianaTimezone（一般設定が未作成のとき）
 * 3) Asia/Tokyo
 */
export async function getShopTimezoneForDaily(
  admin: AdminClient,
  shopId: string
): Promise<string> {
  const general = await getAppSetting<Partial<GeneralSettings>>(shopId, GENERAL_SETTINGS_KEY);
  const appTz = general?.defaultTimezone?.trim();
  if (appTz) return appTz;

  const fromShop = await getShopIanaTimezone(admin);
  if (fromShop) return fromShop;

  return FALLBACK_TIMEZONE;
}

/**
 * Shopify のショップ設定から IANA タイムゾーンを取得する。
 * 取得できない場合は null を返す（呼び出し側で getShopTimezoneForDaily のフォールバックチェーンを使うこと）
 */
export async function getShopIanaTimezone(
  admin: AdminClient
): Promise<string | null> {
  try {
    const json = await adminGraphqlWithRetry<{ data?: { shop?: { ianaTimezone?: string } } }>(
      admin,
      SHOP_TIMEZONE_QUERY,
      undefined,
      "shopTimezone",
    );
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
 * Shopify Admin の orders 検索（GraphQL query の created_at / processed_at など）向け境界文字列。
 * 範囲は店舗タイムゾーンの 0:00:00.000〜23:59:59.999（日本の店は日本時間の 0 時〜23:59）。
 *
 * 書き方はどのタイムゾーンでも UTC の Z 表記（getDayRangeInUtc と同じ）にする。
 * 以前は Asia/Tokyo だけ「YYYY-MM-DDT00:00:00+09:00」を渡していたが、
 * 開発ストア（2026-11-23）で created_at:>=2026-11-23T00:00:00+09:00 が同日 18:14 JST の注文を
 * 返さず、同じ瞬間を Z 表記（2026-11-22T15:00:00Z）にすると返した。
 * Shopify 側でオフセット付きの値がどう読まれているかは未確認（「+」が空白になる等は推測）。
 * 精算のメイン検索・売上サマリー・POS の取引一覧はすでに Z 表記。
 */
export function getDayRangeShopifySearchIso(
  dateStr: string,
  ianaTimezone: string,
): { start: string; end: string } {
  const { startUtcIso, endUtcIso } = getDayRangeInUtc(dateStr, ianaTimezone);
  return { start: startUtcIso, end: endUtcIso };
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

/**
 * ISO 時刻を指定タイムゾーンの「時:分」（24h, HH:mm）に変換する。
 * GAS aggregate の firstTime / lastTime（Utilities.formatDate(..., 'HH:mm')）相当。
 */
export function formatTimeHmInTimeZone(isoUtc: string, ianaTimezone: string): string {
  const d = new Date(isoUtc);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: ianaTimezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(d);
  let hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  let mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  if (hh.length === 1) hh = `0${hh}`;
  if (mm.length === 1) mm = `0${mm}`;
  return `${hh}:${mm}`;
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
