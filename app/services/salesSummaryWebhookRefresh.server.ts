/**
 * orders/updated Webhook 等から呼び出し: 指定暦日の売上サマリー日次キャッシュを再計算する。
 * POS の次回表示は DB キャッシュを読むだけに寄せる。
 */
import prisma from "../db.server";
import { computeAndCacheDailySummary } from "./salesSummaryEngine.server";
import {
  autoDiscoverChannels,
  computeAndCacheChannelDailySummary,
  getEnabledSalesChannels,
} from "./salesChannelEngine.server";
import {
  getCalendarDateStringInTimeZone,
  addCalendarDaysToIsoDate,
  getShopTimezoneForDaily,
} from "../utils/shopTimezone.server";
import { syncRollupsAfterTargetDates } from "./salesSummaryPeriodRollup.server";
import {
  getAppSetting,
  SALES_SUMMARY_SETTINGS_KEY,
  mergeAndNormalizeSalesSummarySettings,
  type SalesSummarySettings,
} from "../utils/appSettings.server";

export type WebhookRefreshAdmin = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

function parseLookbackDays(): number {
  const raw = process.env.SALES_SUMMARY_WEBHOOK_LOOKBACK_DAYS;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 3;
  return Math.min(30, Math.max(1, Math.trunc(n)));
}

/**
 * REST orders/updated ペイロードの日時から、店舗TZでの暦日を推定。
 * 取れなければ「今日」1日だけ。
 */
export function collectOrderRelatedCalendarDates(
  payload: unknown,
  shopIanaTz: string,
  lookbackDays: number,
): string[] {
  const order = payload as Record<string, unknown>;
  const timestamps: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) timestamps.push(v.trim());
  };
  push(order.created_at);
  push(order.updated_at);
  push(order.processed_at);
  const fulfillments = order.fulfillments;
  if (Array.isArray(fulfillments)) {
    for (const f of fulfillments) {
      if (f && typeof f === "object") {
        const o = f as { created_at?: string; updated_at?: string };
        push(o.created_at);
        push(o.updated_at);
      }
    }
  }

  const today = getCalendarDateStringInTimeZone(new Date(), shopIanaTz);
  const lb = Math.max(0, Math.min(30, lookbackDays));
  const minDate = addCalendarDaysToIsoDate(today, -lb);
  const dates = new Set<string>();
  for (const iso of timestamps) {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) continue;
      const cal = getCalendarDateStringInTimeZone(d, shopIanaTz);
      if (cal >= minDate && cal <= today) dates.add(cal);
    } catch {
      /* ignore */
    }
  }
  if (dates.size === 0) dates.add(today);
  return [...dates].sort();
}

/**
 * 有効な売上サマリー設定の店舗について、各ロケーション・各チャネルの日次キャッシュを再計算。
 * 1 組み合わせの失敗で全体を落とさない。
 */
export async function refreshSalesSummaryCachesForTargetDates(
  admin: WebhookRefreshAdmin,
  shopId: string,
  targetDates: string[],
): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  const unique = [...new Set(targetDates)]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  if (unique.length === 0) return { errors };

  const settings = await getAppSetting<Partial<SalesSummarySettings>>(shopId, SALES_SUMMARY_SETTINGS_KEY);
  const merged = mergeAndNormalizeSalesSummarySettings(settings ?? undefined);
  if (!merged.salesSummaryEnabled) return { errors };

  const locations = await prisma.location.findMany({
    where: { shopId, salesSummaryEnabled: true },
  });

  await autoDiscoverChannels(admin, shopId);
  const channels = await getEnabledSalesChannels(shopId);

  for (const targetDate of unique) {
    for (const loc of locations) {
      try {
        await computeAndCacheDailySummary(
          admin,
          shopId,
          loc.shopifyLocationGid,
          loc.name,
          targetDate,
        );
      } catch (e) {
        errors.push(
          `loc ${loc.shopifyLocationGid} ${targetDate}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    for (const ch of channels) {
      try {
        await computeAndCacheChannelDailySummary(
          admin,
          shopId,
          ch.id,
          ch.displayName,
          ch.sourceNames,
          targetDate,
        );
      } catch (e) {
        errors.push(`ch ${ch.id} ${targetDate}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return { errors };
}

/**
 * キューワーカー・同期 Webhook 共通: 日次キャッシュ再計算＋月次ロールアップ。
 */
export async function executeSalesSummaryOrderWebhookJob(
  admin: WebhookRefreshAdmin,
  shopId: string,
  payload: unknown,
): Promise<{ targetDates: string[]; errors: string[] }> {
  const tz = await getShopTimezoneForDaily(admin, shopId);
  const lookback = parseLookbackDays();
  const targetDates = collectOrderRelatedCalendarDates(payload, tz, lookback);
  const { errors } = await refreshSalesSummaryCachesForTargetDates(admin, shopId, targetDates);

  const shopToday = getCalendarDateStringInTimeZone(new Date(), tz);
  const locations = await prisma.location.findMany({
    where: { shopId, salesSummaryEnabled: true },
    select: { shopifyLocationGid: true, name: true },
  });
  await autoDiscoverChannels(admin, shopId);
  const channels = await getEnabledSalesChannels(shopId);
  try {
    await syncRollupsAfterTargetDates(
      shopId,
      shopToday,
      targetDates,
      locations,
      channels.map((c) => ({ id: c.id, displayName: c.displayName })),
    );
  } catch (e) {
    console.error("[sales-summary] rollup sync after webhook:", e);
  }

  return { targetDates, errors };
}

export async function runSalesSummaryRefreshFromOrderWebhook(
  admin: WebhookRefreshAdmin,
  shopId: string,
  payload: unknown,
): Promise<{ targetDates: string[]; errors: string[] }> {
  return executeSalesSummaryOrderWebhookJob(admin, shopId, payload);
}
