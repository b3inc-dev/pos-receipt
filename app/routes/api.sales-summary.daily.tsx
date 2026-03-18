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
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";
import { getAppSetting } from "../utils/appSettings.server";
import { SALES_SUMMARY_SETTINGS_KEY, DEFAULT_SALES_SUMMARY_SETTINGS } from "../utils/appSettings.server";

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
    const targetDate =
      url.searchParams.get("targetDate") ?? new Date().toISOString().slice(0, 10);
    const locationIdsParam = url.searchParams.getAll("locationIds[]");

    if (!merged.salesSummaryEnabled) {
      return corsJson({ rows: [], totals: { actual: 0, orders: 0, items: 0, budget: null, visitors: null }, displayOptions: merged, targetDate });
    }

    let allLocations = await prisma.location.findMany({
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

    let targetLocations =
      locationIdsParam.length > 0
        ? allLocations.filter((l) => {
            const lNum = l.shopifyLocationGid.replace("gid://shopify/Location/", "");
            if (!lNum) return false; // 空 GID は除外
            return locationIdsParam.some((id) => {
              const idNum = id.replace("gid://shopify/Location/", "");
              return lNum === idNum;
            });
          })
        : allLocations;

    // locationIdsParam でフィルタした結果が空の場合は全ロケーションを対象にする
    // (POS セッションの locationId が DB の GID と一致しないケースへの安全網)
    if (locationIdsParam.length > 0 && targetLocations.length === 0) {
      targetLocations = allLocations;
    }

    if (merged.visibleLocationIds.length > 0) {
      const filtered = targetLocations.filter((l) =>
        merged.visibleLocationIds.includes(l.shopifyLocationGid)
      );
      // visibleLocationIds フィルタで空になった場合は無視してフィルタ前を使う
      if (filtered.length > 0) targetLocations = filtered;
    }

    if (targetLocations.length === 0) {
      return corsJson({
        rows: [],
        totals: { actual: 0, orders: 0, items: 0, budget: null, visitors: null },
        displayOptions: merged,
        targetDate,
      });
    }

    // 各ロケーションを並列計算・キャッシュ
    const rows: Array<DailySummaryRowDTO & { footfallReportingEnabled: boolean }> = await Promise.all(
      targetLocations.map(async (loc): Promise<DailySummaryRowDTO & { footfallReportingEnabled: boolean }> => {
        const row = await computeAndCacheDailySummary(
          admin,
          shop.id,
          loc.shopifyLocationGid,
          loc.name,
          targetDate
        );
        return { ...row, footfallReportingEnabled: loc.footfallReportingEnabled };
      })
    );

    // 合計
    const totals = {
      actual: rows.reduce((s, r) => s + r.actual, 0),
      orders: rows.reduce((s, r) => s + r.orders, 0),
      items: rows.reduce((s, r) => s + r.items, 0),
      budget: rows.every((r) => r.budget !== null)
        ? rows.reduce((s, r) => s + (r.budget ?? 0), 0)
        : null,
      visitors: rows.some((r) => r.visitors !== null)
        ? rows.reduce((s, r) => s + (r.visitors ?? 0), 0)
        : null,
    };

    return corsJson({ rows, totals, targetDate, displayOptions: merged });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
