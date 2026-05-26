/**
 * GET /api/settlements/month-rows
 * POS精算モーダル用：月内日別データ一括取得
 * - 過去日：DBのみ参照（Shopify API呼び出しなし）
 * - 当日の Shopify 再集計は行わない（プレビュー API 側でキャッシュ更新。Throttled 防止）
 * Query: locationId, year, month
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  authenticatePosRequestOrCorsError,
  corsErrorJson,
  corsPreflightResponse,
} from "../utils/posAuth.server";
import prisma from "../db.server";

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
    const { shop, corsJson } = authResult;

    const url = new URL(request.url);
    const locationId = url.searchParams.get("locationId");
    const year = parseInt(url.searchParams.get("year") ?? "", 10);
    const month = parseInt(url.searchParams.get("month") ?? "", 10);

    if (!locationId || !year || !month || month < 1 || month > 12) {
      return corsJson(
        { ok: false, error: "locationId, year, month are required" },
        { status: 400 }
      );
    }

    const locationGid = locationId.startsWith("gid://")
      ? locationId
      : `gid://shopify/Location/${locationId}`;
    const locIdRaw = locationGid.replace("gid://shopify/Location/", "");
    const locationIds = [locationGid, locIdRaw];

    const today = todayStr();
    const ym = `${year}-${String(month).padStart(2, "0")}`;
    const dateFrom = `${ym}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const dateTo = `${ym}-${String(lastDay).padStart(2, "0")}`;
    const effectiveDateTo = dateTo > today ? today : dateTo;
    // DB から Settlement・キャッシュを一括取得（Shopify API呼び出しなし）
    const [settlements, cacheRows] = await Promise.all([
      prisma.settlement.findMany({
        where: {
          shopId: shop.id,
          locationId: { in: locationIds },
          targetDate: { gte: dateFrom, lte: effectiveDateTo },
        },
        orderBy: [{ targetDate: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          targetDate: true,
          periodLabel: true,
          total: true,
          netSales: true,
          orderCount: true,
          refundCount: true,
          itemCount: true,
          printMode: true,
          status: true,
          sourceOrderName: true,
          createdAt: true,
        },
      }),
      prisma.salesSummaryCacheDaily.findMany({
        where: {
          shopId: shop.id,
          locationId: { in: locationIds },
          targetDate: { gte: dateFrom, lte: effectiveDateTo },
        },
        select: { targetDate: true, actual: true },
      }),
    ]);

    // 日付別マップ（同日複数精算は最新を採用）
    const settlementByDate = new Map<string, typeof settlements[number]>();
    for (const s of settlements) {
      const prev = settlementByDate.get(s.targetDate);
      if (!prev || s.createdAt > prev.createdAt) {
        settlementByDate.set(s.targetDate, s);
      }
    }

    const cacheByDate = new Map<string, number>();
    for (const c of cacheRows) {
      if (!cacheByDate.has(c.targetDate)) {
        cacheByDate.set(c.targetDate, Number(c.actual));
      }
    }

    // 日別行を組み立て（新しい日付順）
    const days = buildDaysInMonth(year, month);
    const rows = days
      .map((targetDate) => {
        const settlement = settlementByDate.get(targetDate) ?? null;
        const cached = cacheByDate.get(targetDate) ?? null;
        // netSales優先順: 精算確定値 > キャッシュ > 0
        const netSales = settlement
          ? Number(settlement.netSales)
          : (cached ?? 0);

        return {
          targetDate,
          netSales,
          settlement: settlement
            ? {
                id: settlement.id,
                targetDate: settlement.targetDate,
                periodLabel: settlement.periodLabel,
                total: Number(settlement.total),
                netSales: Number(settlement.netSales),
                orderCount: settlement.orderCount,
                refundCount: settlement.refundCount,
                itemCount: settlement.itemCount,
                printMode: settlement.printMode,
                status: settlement.status,
                sourceOrderName: settlement.sourceOrderName,
                createdAt: settlement.createdAt.toISOString(),
                isInspection: settlement.periodLabel?.startsWith("点検_") ?? false,
              }
            : null,
        };
      })
      .reverse(); // 新しい日付を先頭に

    return corsJson({ ok: true, rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
