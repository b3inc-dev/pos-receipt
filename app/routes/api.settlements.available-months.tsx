/**
 * GET /api/settlements/available-months
 * POS精算モーダル用：月ナビゲーション一覧取得
 * DBのみ参照（Shopify API呼び出しなし）
 * Query: locationId
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  authenticatePosRequestOrCorsError,
  corsErrorJson,
  corsPreflightResponse,
} from "../utils/posAuth.server";
import prisma from "../db.server";

function extractYearMonth(dateStr: string): string | null {
  const m = dateStr.match(/^(\d{4}-\d{2})/);
  return m?.[1] ?? null;
}

/** 最古月から今月まで連続した全月を埋めて新しい順で返す */
function fillMonthRange(monthSet: Set<string>): string[] {
  const now = new Date();
  const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  if (monthSet.size === 0) {
    return [current];
  }

  const sorted = Array.from(monthSet).sort();
  const earliest = sorted[0] <= current ? sorted[0] : current;

  const result: string[] = [];
  let [y, m] = earliest.split("-").map(Number);
  const [cy, cm] = current.split("-").map(Number);

  while (y < cy || (y === cy && m <= cm)) {
    result.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }

  return result.reverse(); // 新しい月を先頭に
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { shop, corsJson } = authResult;

    const url = new URL(request.url);
    const locationId = url.searchParams.get("locationId");

    if (!locationId) {
      return corsJson({ ok: false, error: "locationId is required" }, { status: 400 });
    }

    // GID・数値IDの両形式に対応
    const locationGid = locationId.startsWith("gid://")
      ? locationId
      : `gid://shopify/Location/${locationId}`;
    const locIdRaw = locationGid.replace("gid://shopify/Location/", "");
    const locationIds = [locationGid, locIdRaw];

    // Settlement と SalesSummaryCacheDaily から distinct な日付を並列取得
    const [settlementDates, cacheDates] = await Promise.all([
      prisma.settlement.findMany({
        where: { shopId: shop.id, locationId: { in: locationIds } },
        select: { targetDate: true },
        distinct: ["targetDate"],
        orderBy: { targetDate: "asc" },
      }),
      prisma.salesSummaryCacheDaily.findMany({
        where: { shopId: shop.id, locationId: { in: locationIds } },
        select: { targetDate: true },
        distinct: ["targetDate"],
        orderBy: { targetDate: "asc" },
      }),
    ]);

    const monthSet = new Set<string>();
    for (const { targetDate } of [...settlementDates, ...cacheDates]) {
      const ym = extractYearMonth(targetDate);
      if (ym) monthSet.add(ym);
    }

    const months = fillMonthRange(monthSet);
    return corsJson({ ok: true, months });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
