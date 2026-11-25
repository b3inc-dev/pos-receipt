/**
 * GET /api/settlements/export-csv
 * 照合用 CSV（保存済みの精算 × 店舗・日・支払方法）をダウンロードする。管理画面（埋め込み）用。
 *
 * - DB の Settlement 行だけを読む。Shopify の注文の再取得・再集計はしない。
 * - Query:
 *     dateFrom, dateTo  … 精算の対象日（YYYY-MM-DD、両端を含む、最大 366 日）
 *     locationId        … 任意。カンマ区切りで複数可（GID または数値 ID）。省略時は全店舗
 * - 列・通貨・タイムゾーン・対象範囲は CSV 先頭の「#」行に書く。
 *
 * 精算履歴画面のダウンロードボタンは、その画面を作り直す #22 が main に入ったあとで付ける。
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import {
  buildSettlementCsv,
  countDaysInclusive,
  isValidYmd,
  SETTLEMENT_CSV_MAX_DAYS,
  toLocationGid,
  toLocationNumericId,
} from "../services/settlementCsvPure.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const url = new URL(request.url);
  const dateFrom = (url.searchParams.get("dateFrom") ?? "").trim();
  const dateTo = (url.searchParams.get("dateTo") ?? "").trim();

  if (!isValidYmd(dateFrom) || !isValidYmd(dateTo)) {
    return Response.json(
      { ok: false, error: "dateFrom と dateTo を YYYY-MM-DD で指定してください" },
      { status: 400 },
    );
  }
  const days = countDaysInclusive(dateFrom, dateTo);
  if (days < 1) {
    return Response.json({ ok: false, error: "dateFrom は dateTo 以前にしてください" }, { status: 400 });
  }
  if (days > SETTLEMENT_CSV_MAX_DAYS) {
    return Response.json(
      { ok: false, error: `対象期間は ${SETTLEMENT_CSV_MAX_DAYS} 日以内にしてください` },
      { status: 400 },
    );
  }

  const requestedLocations = url.searchParams
    .getAll("locationId")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  // 保存値は GID と数値 ID のどちらもあり得るため両方で引く
  const locationIdVariants = [
    ...new Set(requestedLocations.flatMap((id) => [toLocationGid(id), toLocationNumericId(id)])),
  ];

  const [settlements, locations, timezone] = await Promise.all([
    prisma.settlement.findMany({
      where: {
        shopId: shop.id,
        targetDate: { gte: dateFrom, lte: dateTo },
        ...(locationIdVariants.length > 0 ? { locationId: { in: locationIdVariants } } : {}),
      },
      orderBy: [{ targetDate: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        locationId: true,
        targetDate: true,
        periodLabel: true,
        currency: true,
        total: true,
        netSales: true,
        tax: true,
        discounts: true,
        vipPointsUsed: true,
        refundTotal: true,
        orderCount: true,
        refundCount: true,
        voucherChangeAmount: true,
        paymentSectionsJson: true,
        status: true,
        createdAt: true,
      },
    }),
    prisma.location.findMany({
      where: { shopId: shop.id },
      select: { shopifyLocationGid: true, name: true, displayName: true, sortOrder: true },
    }),
    getShopTimezoneForDaily(admin, shop.id),
  ]);

  const locationNames = new Map<string, string>();
  const locationSortOrder = new Map<string, number>();
  for (const l of locations) {
    const gid = toLocationGid(l.shopifyLocationGid);
    locationNames.set(gid, l.displayName?.trim() || l.name);
    locationSortOrder.set(gid, l.sortOrder);
  }

  const locationFilterLabel =
    requestedLocations.length === 0
      ? "全店舗"
      : requestedLocations
          .map((id) => locationNames.get(toLocationGid(id)) || toLocationNumericId(id))
          .join(" / ");

  const result = buildSettlementCsv(settlements, {
    dateFrom,
    dateTo,
    timezone,
    locationNames,
    locationSortOrder,
    locationFilterLabel,
    generatedAt: new Date(),
  });

  const filename = `settlements_${dateFrom}_${dateTo}.csv`;
  return new Response(result.csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(
        `精算照合_${dateFrom}_${dateTo}.csv`,
      )}`,
      "Cache-Control": "no-store",
      "X-Settlement-Count": String(result.settlementCount),
    },
  });
}
