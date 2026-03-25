/**
 * GET /api/sales-summary/period
 * 要件書 §21.6: 期間売上サマリー
 * Query: dateFrom, dateTo, locationIds[]
 * 設定 §10: 売上サマリー設定で表示対象を制御
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { computeAndCacheDailySummary } from "../services/salesSummaryEngine.server";
import { autoDiscoverChannels, computeAndCacheChannelDailySummary, getEnabledSalesChannels } from "../services/salesChannelEngine.server";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";
import {
  getAppSetting,
  SALES_SUMMARY_SETTINGS_KEY,
  mergeAndNormalizeSalesSummarySettings,
  type SalesSummarySettings,
} from "../utils/appSettings.server";

type SalesSummaryLocationRow = Awaited<ReturnType<typeof prisma.location.findMany>>[number];

/** キャッシュの locationId が GID / 数値のどちらでも findMany にヒットするよう列挙 */
function expandLocationIdsForCacheQuery(targetLocations: SalesSummaryLocationRow[]): string[] {
  const s = new Set<string>();
  for (const l of targetLocations) {
    const g = l.shopifyLocationGid;
    const raw = g.replace("gid://shopify/Location/", "");
    s.add(g);
    if (raw) s.add(raw);
  }
  return [...s];
}

/** キャッシュ行の locationId を店舗マスタ上の正規 GID に寄せる（期間集計のキーぶれ防止） */
function resolveCanonicalLocationGid(
  targetLocations: SalesSummaryLocationRow[],
  rowLocationId: string,
): string | null {
  for (const l of targetLocations) {
    const g = l.shopifyLocationGid;
    const raw = g.replace("gid://shopify/Location/", "");
    if (rowLocationId === g || rowLocationId === raw) return g;
  }
  return null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;
    const fullAccess = await getFullAccess(admin, { shop: shop.shopDomain });

    const access = checkPlanAccess(shop.planCode, "sales_summary", fullAccess);
    if (!access.allowed) {
      return corsJson({ ok: false, error: access.message }, { status: 403 });
    }

    const settings = await getAppSetting<Partial<SalesSummarySettings>>(shop.id, SALES_SUMMARY_SETTINGS_KEY);
    const merged = mergeAndNormalizeSalesSummarySettings(settings ?? undefined);
    if (!merged.salesSummaryEnabled) {
      return corsJson({ rows: [], totals: {}, dateFrom: null, dateTo: null, displayOptions: merged });
    }

    const url = new URL(request.url);
    const dateFrom = url.searchParams.get("dateFrom");
    const dateTo = url.searchParams.get("dateTo");
    const locationIdsParam = url.searchParams.getAll("locationIds[]");

    let allLocations: SalesSummaryLocationRow[] = await prisma.location.findMany({
      where: { shopId: shop.id, salesSummaryEnabled: true },
    });

    // フォールバック: DB に salesSummaryEnabled な Location が未設定の場合は
    // Shopify のアクティブなロケーションを自動同期して有効化する
    if (allLocations.length === 0) {
      const locRes = await admin.graphql(`#graphql
        query { locations(first: 50, includeLegacy: false) { nodes { id name isActive } } }
      `);
      const locJson = (await locRes.json()) as {
        data?: { locations?: { nodes?: { id: string; name: string; isActive: boolean }[] } };
      };
      const shopifyLocs = (locJson.data?.locations?.nodes ?? []).filter((l) => l.isActive);
      for (const loc of shopifyLocs) {
        await prisma.location.upsert({
          where: { shopId_shopifyLocationGid: { shopId: shop.id, shopifyLocationGid: loc.id } },
          update: { name: loc.name, salesSummaryEnabled: true },
          create: { shopId: shop.id, shopifyLocationGid: loc.id, name: loc.name, salesSummaryEnabled: true },
        });
      }
      allLocations = await prisma.location.findMany({
        where: { shopId: shop.id, salesSummaryEnabled: true },
      });
    }

    let targetLocations: SalesSummaryLocationRow[] =
      locationIdsParam.length > 0
        ? allLocations.filter((l: SalesSummaryLocationRow) => {
            const lNum = l.shopifyLocationGid.replace("gid://shopify/Location/", "");
            if (!lNum) return false; // 空 GID は除外
            return locationIdsParam.some((id) => {
              const idNum = id.replace("gid://shopify/Location/", "");
              return lNum === idNum;
            });
          })
        : allLocations;

    // locationIds 指定時は厳密一致のみ対象にする（不一致時に全店舗へフォールバックしない）

    if (merged.visibleLocationIds.length > 0) {
      const filtered = targetLocations.filter((l: SalesSummaryLocationRow) =>
        merged.visibleLocationIds.includes(l.shopifyLocationGid)
      );
      targetLocations = filtered;
    }

    const locationGids = targetLocations.map((l) => l.shopifyLocationGid);
    const locationIdsForQuery = expandLocationIdsForCacheQuery(targetLocations);

    if (locationGids.length === 0) {
      return corsJson({ rows: [], totals: {}, dateFrom, dateTo, displayOptions: merged });
    }

    // 期間表示時は先に日次キャッシュを再計算する。
    // 日ごとに全ロケーションを並列にし、日×店の同時 GraphQL を抑えてレート制限を避ける。
    await autoDiscoverChannels(admin, shop.id);
    const enabledChannels = await getEnabledSalesChannels(shop.id);
    if (dateFrom && dateTo) {
      const start = new Date(dateFrom + "T00:00:00Z").getTime();
      const end = new Date(dateTo + "T23:59:59Z").getTime();
      const days: string[] = [];
      for (let t = start; t <= end; t += 86400000) {
        days.push(new Date(t).toISOString().slice(0, 10));
      }
      for (const targetDate of days) {
        // POS ロケーション（並列）
        await Promise.all(
          targetLocations.map((loc) =>
            computeAndCacheDailySummary(admin, shop.id, loc.shopifyLocationGid, loc.name, targetDate)
          )
        );
        // チャネル（逐次: レート制限対策）
        for (const ch of enabledChannels) {
          await computeAndCacheChannelDailySummary(admin, shop.id, ch.id, ch.displayName, ch.sourceNames, targetDate);
        }
      }
    }

    // 日次キャッシュから集計
    const whereTargetDate: Record<string, string> = {};
    if (dateFrom) whereTargetDate.gte = dateFrom;
    if (dateTo) whereTargetDate.lte = dateTo;

    const dailyRows = await prisma.salesSummaryCacheDaily.findMany({
      where: {
        shopId: shop.id,
        locationId: { in: locationIdsForQuery },
        ...(Object.keys(whereTargetDate).length > 0 ? { targetDate: whereTargetDate } : {}),
      },
    });

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const locNameMap = new Map(targetLocations.map((l) => [l.shopifyLocationGid, l.name]));

    // ロケーション別集計
    const locationMap = new Map<
      string,
      {
        locationId: string;
        locationName: string;
        actualTotal: number;
        budgetTotal: number | null;
        orders: number;
        items: number;
        visitors: number | null;
        progressBudgetToday: number;
        progressBudgetPrev: number;
      }
    >();

    for (const row of dailyRows) {
      const canon = resolveCanonicalLocationGid(targetLocations, row.locationId);
      if (!canon) continue;
      if (!locationMap.has(canon)) {
        locationMap.set(canon, {
          locationId: canon,
          locationName: locNameMap.get(canon) ?? canon,
          actualTotal: 0,
          budgetTotal: null,
          orders: 0,
          items: 0,
          visitors: null,
          progressBudgetToday: 0,
          progressBudgetPrev: 0,
        });
      }
      const entry = locationMap.get(canon)!;
      entry.actualTotal += Number(row.actual);
      entry.orders += row.orders;
      entry.items += row.items;
      if (row.visitors !== null) {
        entry.visitors = (entry.visitors ?? 0) + row.visitors;
      }
      if (row.budget !== null) {
        entry.budgetTotal = (entry.budgetTotal ?? 0) + Number(row.budget);
        if (row.targetDate <= today) entry.progressBudgetToday += Number(row.budget);
        if (row.targetDate <= yesterday) entry.progressBudgetPrev += Number(row.budget);
      }
    }

    const rows = Array.from(locationMap.values()).map((entry) => ({
      ...entry,
      achievementRate:
        entry.budgetTotal && entry.budgetTotal > 0
          ? entry.actualTotal / entry.budgetTotal
          : null,
      progressRateToday:
        entry.progressBudgetToday > 0
          ? entry.actualTotal / entry.progressBudgetToday
          : null,
      progressRatePrev:
        entry.progressBudgetPrev > 0
          ? entry.actualTotal / entry.progressBudgetPrev
          : null,
      conv:
        entry.visitors !== null && entry.visitors > 0
          ? entry.orders / entry.visitors
          : null,
      atv: entry.orders > 0 ? entry.actualTotal / entry.orders : null,
      setRate: entry.orders > 0 ? entry.items / entry.orders : null,
      unit: entry.items > 0 ? entry.actualTotal / entry.items : null,
    }));

    // ── チャネル集計（キャッシュから取得） ──────────────────────────────────
    const channelRows = await (async () => {
      if (enabledChannels.length === 0 || !dateFrom || !dateTo) return [];

      const channelCaches = await prisma.salesChannelCacheDaily.findMany({
        where: {
          shopId: shop.id,
          channelId: { in: enabledChannels.map((c) => c.id) },
          targetDate: {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo ? { lte: dateTo } : {}),
          },
        },
      });

      const channelMap = new Map<string, { channelId: string; channelName: string; actualTotal: number; budgetTotal: number | null; orders: number; items: number }>();
      for (const ch of enabledChannels) {
        channelMap.set(ch.id, { channelId: ch.id, channelName: ch.displayName, actualTotal: 0, budgetTotal: null, orders: 0, items: 0 });
      }
      for (const c of channelCaches) {
        const entry = channelMap.get(c.channelId);
        if (!entry) continue;
        entry.actualTotal += Number(c.actual);
        entry.orders += c.orders;
        entry.items += c.items;
        if (c.budget !== null) entry.budgetTotal = (entry.budgetTotal ?? 0) + Number(c.budget);
      }

      return Array.from(channelMap.values()).map((entry) => ({
        ...entry,
        achievementRate: entry.budgetTotal && entry.budgetTotal > 0 ? entry.actualTotal / entry.budgetTotal : null,
      }));
    })();

    const storeOrders = rows.reduce((s, r) => s + r.orders, 0);
    const storeVisitors = rows.some((r) => r.visitors !== null)
      ? rows.reduce((s, r) => s + (r.visitors ?? 0), 0)
      : null;
    const totalActual =
      rows.reduce((s, r) => s + r.actualTotal, 0) +
      channelRows.reduce((s, r) => s + r.actualTotal, 0);
    const totalOrders =
      rows.reduce((s, r) => s + r.orders, 0) +
      channelRows.reduce((s, r) => s + r.orders, 0);
    const totalItems =
      rows.reduce((s, r) => s + r.items, 0) +
      channelRows.reduce((s, r) => s + r.items, 0);
    const totals = {
      actualTotal: totalActual,
      budgetTotal: rows.every((r) => r.budgetTotal !== null)
        ? rows.reduce((s, r) => s + (r.budgetTotal ?? 0), 0)
        : null,
      orders: totalOrders,
      items: totalItems,
      visitors: storeVisitors,
      conv: storeVisitors !== null && storeVisitors > 0 ? storeOrders / storeVisitors : null,
      atv: totalOrders > 0 ? totalActual / totalOrders : null,
      setRate: totalOrders > 0 ? totalItems / totalOrders : null,
      unit: totalItems > 0 ? totalActual / totalItems : null,
    };

    return corsJson({ rows, channelRows, totals, dateFrom, dateTo, displayOptions: merged });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
