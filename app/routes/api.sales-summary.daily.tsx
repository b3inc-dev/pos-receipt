/**
 * GET /api/sales-summary/daily
 * 要件書 §21.6: 日次売上サマリー
 * Query: targetDate, locationIds[]
 * 設定 §10: 売上サマリー設定で表示対象・KPI を制御
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { computeAndCacheDailySummary, type DailySummaryRowDTO } from "../services/salesSummaryEngine.server";
import {
  autoDiscoverChannels,
  computeAndCacheChannelDailySummary,
  getEnabledSalesChannels,
  type ChannelDailySummaryDTO,
} from "../services/salesChannelEngine.server";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";
import { getAppSetting } from "../utils/appSettings.server";
import {
  SALES_SUMMARY_SETTINGS_KEY,
  mergeAndNormalizeSalesSummarySettings,
  isFootfallReportingAllowedForLocation,
  type SalesSummarySettings,
} from "../utils/appSettings.server";
import { getLocationBudgetAmountsForDayBatch } from "../utils/salesSummaryBudgetFromDb.server";
import { getShopTimezoneForDaily, getCalendarDateStringInTimeZone } from "../utils/shopTimezone.server";

type SalesSummaryLocationRow = Awaited<ReturnType<typeof prisma.location.findMany>>[number];

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

    const shopIanaTz = await getShopTimezoneForDaily(admin, shop.id);
    const shopCalendarToday = getCalendarDateStringInTimeZone(new Date(), shopIanaTz);

    const settings = await getAppSetting<Partial<SalesSummarySettings>>(shop.id, SALES_SUMMARY_SETTINGS_KEY);
    const merged = mergeAndNormalizeSalesSummarySettings(settings ?? undefined);
    const url = new URL(request.url);
    const targetDate = url.searchParams.get("targetDate") ?? shopCalendarToday;
    const locationIdsParam = url.searchParams.getAll("locationIds[]");
    /** 過去日でも日次キャッシュを使わず Shopify から取り直してキャッシュを上書きする */
    const forceRecompute = url.searchParams.get("recompute") === "1";

    if (!merged.salesSummaryEnabled) {
      return corsJson({
        rows: [],
        totals: { actual: 0, orders: 0, items: 0, budget: null, visitors: null },
        displayOptions: merged,
        targetDate,
        calendarToday: shopCalendarToday,
      });
    }

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

    if (targetLocations.length === 0) {
      return corsJson({
        rows: [],
        totals: { actual: 0, orders: 0, items: 0, budget: null, visitors: null },
        displayOptions: merged,
        targetDate,
        calendarToday: shopCalendarToday,
      });
    }

    const today = shopCalendarToday;
    const isPastDate = targetDate < today;

    // 精算側の「過去日=DB中心」方針に合わせる:
    // - 過去日: まず日次キャッシュを優先利用（未キャッシュ時のみ再計算）
    // - 当日: 毎回再計算。全店舗時は店舗を順に処理し GraphQL の同時実行を抑える。
    const buildRow = async (
      loc: SalesSummaryLocationRow,
    ): Promise<DailySummaryRowDTO & { footfallReportingEnabled: boolean }> => {
      const locationGid = loc.shopifyLocationGid;
      const locationRawId = locationGid.replace("gid://shopify/Location/", "");

      if (isPastDate && !forceRecompute) {
        const cached = await prisma.salesSummaryCacheDaily.findFirst({
          where: {
            shopId: shop.id,
            locationId: { in: [locationGid, locationRawId] },
            targetDate,
          },
        });

        if (cached) {
          const cachedRow: DailySummaryRowDTO = {
            locationId: locationGid,
            locationName: loc.name,
            targetDate,
            actual: Number(cached.actual),
            orders: cached.orders,
            items: cached.items,
            visitors: cached.visitors,
            budget: cached.budget !== null ? Number(cached.budget) : null,
            budgetRatio: cached.budgetRatio !== null ? Number(cached.budgetRatio) : null,
            conv: cached.conv !== null ? Number(cached.conv) : null,
            atv: cached.atv !== null ? Number(cached.atv) : null,
            setRate: cached.setRate !== null ? Number(cached.setRate) : null,
            unit: cached.unit !== null ? Number(cached.unit) : null,
            currency: "JPY",
          };
          return {
            ...cachedRow,
            footfallReportingEnabled: isFootfallReportingAllowedForLocation(merged, locationGid),
          };
        }
      }

      const row = await computeAndCacheDailySummary(admin, shop.id, locationGid, loc.name, targetDate);
      return {
        ...row,
        footfallReportingEnabled: isFootfallReportingAllowedForLocation(merged, locationGid),
      };
    };

    const useSequentialToday =
      !isPastDate && targetLocations.length > 1;
    let rows: Array<DailySummaryRowDTO & { footfallReportingEnabled: boolean }>;
    if (useSequentialToday) {
      rows = [];
      for (const loc of targetLocations) {
        rows.push(await buildRow(loc));
      }
    } else {
      rows = await Promise.all(targetLocations.map((loc) => buildRow(loc)));
    }

    const budgetByLocDay = await getLocationBudgetAmountsForDayBatch(
      shop.id,
      rows.map((r) => r.locationId),
      targetDate,
    );
    rows = rows.map((r) => {
      const budget = budgetByLocDay.get(r.locationId) ?? null;
      const budgetRatio = budget != null && budget > 0 ? r.actual / budget : null;
      return { ...r, budget, budgetRatio };
    });

    // ── チャネル行集計 ────────────────────────────────────────────────────────
    await autoDiscoverChannels(admin, shop.id);
    const enabledChannels = await getEnabledSalesChannels(shop.id);
    const buildChannelRow = async (ch: Awaited<ReturnType<typeof getEnabledSalesChannels>>[number]): Promise<ChannelDailySummaryDTO> => {
      if (isPastDate && !forceRecompute) {
        const cached = await prisma.salesChannelCacheDaily.findFirst({
          where: { shopId: shop.id, channelId: ch.id, targetDate },
        });
        // sourceNamesSnapshot が現在設定と一致していればキャッシュを使用
        if (cached && ch.sourceNamesJson === ch.sourceNamesSnapshot) {
          return {
            channelId: ch.id,
            channelName: ch.displayName,
            targetDate,
            actual: Number(cached.actual),
            orders: cached.orders,
            items: cached.items,
            budget: cached.budget !== null ? Number(cached.budget) : null,
            budgetRatio: cached.budgetRatio !== null ? Number(cached.budgetRatio) : null,
            atv: cached.atv !== null ? Number(cached.atv) : null,
            setRate: cached.setRate !== null ? Number(cached.setRate) : null,
            unit: cached.unit !== null ? Number(cached.unit) : null,
            currency: cached.currency,
          };
        }
      }
      return computeAndCacheChannelDailySummary(admin, shop.id, ch.id, ch.displayName, ch.sourceNames, targetDate);
    };

    let channelRows: ChannelDailySummaryDTO[] = [];
    if (enabledChannels.length > 0) {
      if (!isPastDate && enabledChannels.length > 1) {
        // 当日・複数チャネルは逐次処理でレート制限を抑える
        for (const ch of enabledChannels) {
          channelRows.push(await buildChannelRow(ch));
        }
      } else {
        channelRows = await Promise.all(enabledChannels.map(buildChannelRow));
      }
    }

    // ── 合計（全チャネルを含む・管理画面「総合計」と同じ予算ルール） ─────────────
    const grandForBudget = [...rows, ...channelRows];
    const budget =
      grandForBudget.length > 0 &&
      grandForBudget.every((r) => r.budget !== null && r.budget !== undefined)
        ? grandForBudget.reduce((s, r) => s + Number(r.budget ?? 0), 0)
        : null;
    const totals = {
      actual: rows.reduce((s, r) => s + r.actual, 0) + channelRows.reduce((s, r) => s + r.actual, 0),
      orders: rows.reduce((s, r) => s + r.orders, 0) + channelRows.reduce((s, r) => s + r.orders, 0),
      items: rows.reduce((s, r) => s + r.items, 0) + channelRows.reduce((s, r) => s + r.items, 0),
      budget,
      visitors: rows.some((r) => r.visitors !== null)
        ? rows.reduce((s, r) => s + (r.visitors ?? 0), 0)
        : null,
    };

    return corsJson({
      rows,
      channelRows,
      totals,
      targetDate,
      calendarToday: shopCalendarToday,
      displayOptions: merged,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
