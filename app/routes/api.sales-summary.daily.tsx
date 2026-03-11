/**
 * GET /api/sales-summary/daily
 * 要件書 §21.6: 日次売上サマリー
 * Query: targetDate, locationIds[]
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { computeAndCacheDailySummary } from "../services/salesSummaryEngine.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { admin, session } = await authenticate.public(request);
    const shop = await resolveShop(session.shop, admin);

    const url = new URL(request.url);
    const targetDate =
      url.searchParams.get("targetDate") ?? new Date().toISOString().slice(0, 10);
    const locationIdsParam = url.searchParams.getAll("locationIds[]");

    // サマリー有効ロケーション取得
    const allLocations = await prisma.location.findMany({
      where: { shopId: shop.id, salesSummaryEnabled: true },
    });

    const targetLocations =
      locationIdsParam.length > 0
        ? allLocations.filter((l) =>
            locationIdsParam.some(
              (id) =>
                l.shopifyLocationGid === id ||
                l.shopifyLocationGid.endsWith(`/${id}`) ||
                id.endsWith(l.shopifyLocationGid.replace("gid://shopify/Location/", ""))
            )
          )
        : allLocations;

    if (targetLocations.length === 0) {
      return Response.json({
        rows: [],
        totals: { actual: 0, orders: 0, items: 0, budget: null, visitors: null },
      });
    }

    // 各ロケーションを並列計算・キャッシュ
    const rows = await Promise.all(
      targetLocations.map(async (loc) => {
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

    return Response.json({ rows, totals, targetDate });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
