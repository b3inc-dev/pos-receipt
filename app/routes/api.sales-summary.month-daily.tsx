/**
 * GET /api/sales-summary/month-daily
 * 売上サマリー「日別一覧」用：指定月の各日について日次キャッシュのKPIをまとめて返す
 * Query: locationId, year, month
 * 精算の month-rows とは別（純売上に加え客数・入店数・購買率など比較用）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { computeAndCacheDailySummary } from "../services/salesSummaryEngine.server";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";
import { getAppSetting } from "../utils/appSettings.server";
import { SALES_SUMMARY_SETTINGS_KEY, DEFAULT_SALES_SUMMARY_SETTINGS } from "../utils/appSettings.server";

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildDaysInMonth(year: number, month: number): string[] {
  const today = todayStr();
  const lastDay = new Date(year, month, 0).getDate();
  const days: string[] = [];
  for (let d = 1; d <= lastDay; d++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (dateStr > today) break;
    days.push(dateStr);
  }
  return days;
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

    const settings = await getAppSetting<typeof DEFAULT_SALES_SUMMARY_SETTINGS>(shop.id, SALES_SUMMARY_SETTINGS_KEY);
    const merged = { ...DEFAULT_SALES_SUMMARY_SETTINGS, ...settings };

    const url = new URL(request.url);
    const locationId = url.searchParams.get("locationId");
    const year = parseInt(url.searchParams.get("year") ?? "", 10);
    const month = parseInt(url.searchParams.get("month") ?? "", 10);

    if (!locationId || !year || !month || month < 1 || month > 12) {
      return corsJson({ ok: false, error: "locationId, year, month are required" }, { status: 400 });
    }

    if (!merged.salesSummaryEnabled) {
      return corsJson({ rows: [], displayOptions: merged, year, month });
    }

    const locationGid = locationId.startsWith("gid://")
      ? locationId
      : `gid://shopify/Location/${locationId}`;
    const locIdRaw = locationGid.replace("gid://shopify/Location/", "");
    const locationIds = [locationGid, locIdRaw];

    let loc = await prisma.location.findFirst({
      where: { shopId: shop.id, shopifyLocationGid: locationGid, salesSummaryEnabled: true },
    });

    if (!loc) {
      const locRes = await admin.graphql(`#graphql
        query { locations(first: 50, includeLegacy: false) { nodes { id name isActive } } }
      `);
      const locJson = (await locRes.json()) as {
        data?: { locations?: { nodes?: { id: string; name: string; isActive: boolean }[] } };
      };
      const shopifyLocs = (locJson.data?.locations?.nodes ?? []).filter((l) => l.isActive);
      for (const l of shopifyLocs) {
        await prisma.location.upsert({
          where: { shopId_shopifyLocationGid: { shopId: shop.id, shopifyLocationGid: l.id } },
          update: { name: l.name, salesSummaryEnabled: true },
          create: { shopId: shop.id, shopifyLocationGid: l.id, name: l.name, salesSummaryEnabled: true },
        });
      }
      loc = await prisma.location.findFirst({
        where: { shopId: shop.id, shopifyLocationGid: locationGid, salesSummaryEnabled: true },
      });
    }

    if (!loc) {
      return corsJson({ rows: [], displayOptions: merged, year, month });
    }

    if (merged.visibleLocationIds.length > 0 && !merged.visibleLocationIds.includes(locationGid)) {
      return corsJson({ rows: [], displayOptions: merged, year, month });
    }

    const today = todayStr();
    const ym = `${year}-${String(month).padStart(2, "0")}`;
    const dateFrom = `${ym}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const dateTo = `${ym}-${String(lastDay).padStart(2, "0")}`;
    const effectiveDateTo = dateTo > today ? today : dateTo;
    const isCurrentMonth = today.startsWith(ym);

    if (isCurrentMonth) {
      const todayCache = await prisma.salesSummaryCacheDaily.findFirst({
        where: {
          shopId: shop.id,
          locationId: { in: locationIds },
          targetDate: today,
        },
        select: { id: true },
      });
      if (!todayCache) {
        try {
          await computeAndCacheDailySummary(admin, shop.id, locationGid, loc.name, today);
        } catch {
          // 当日のみ失敗しても一覧は続行
        }
      }
    }

    const cacheRows = await prisma.salesSummaryCacheDaily.findMany({
      where: {
        shopId: shop.id,
        locationId: { in: locationIds },
        targetDate: { gte: dateFrom, lte: effectiveDateTo },
      },
      select: {
        targetDate: true,
        actual: true,
        orders: true,
        items: true,
        visitors: true,
        conv: true,
        atv: true,
        setRate: true,
        unit: true,
        updatedAt: true,
      },
    });

    const cacheByDate = new Map<string, (typeof cacheRows)[number]>();
    for (const c of cacheRows) {
      const prev = cacheByDate.get(c.targetDate);
      if (!prev || c.updatedAt > prev.updatedAt) {
        cacheByDate.set(c.targetDate, c);
      }
    }

    const days = buildDaysInMonth(year, month);
    const rows = days
      .map((targetDate) => {
        const c = cacheByDate.get(targetDate);
        return {
          targetDate,
          netSales: c != null ? Number(c.actual) : null,
          orders: c?.orders ?? null,
          items: c?.items ?? null,
          visitors: c?.visitors ?? null,
          conv: c?.conv != null ? Number(c.conv) : null,
          atv: c?.atv != null ? Number(c.atv) : null,
          setRate: c?.setRate != null ? Number(c.setRate) : null,
          unit: c?.unit != null ? Number(c.unit) : null,
        };
      })
      .reverse();

    return corsJson({ ok: true, rows, displayOptions: merged, year, month });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
