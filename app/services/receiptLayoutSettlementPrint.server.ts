/**
 * 精算・点検レシートを、管理画面のレイアウト（#69）で作る
 * 保存済みの Settlement の値だけを使う（ライブ再集計しない・注文や精算の行を作らない）。
 */
import { getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import { locationData, settlementTemplateData } from "./receiptLayoutAdapters";
import { getSettlementCalc, renderLayoutForPrint } from "./receiptLayoutPrint.server";
import type { ReceiptLayout } from "./receiptLayoutSchema";
import { parsePaymentSectionsJson, settlementReceiptTitle } from "./settlementPrintSnapshot.server";
import type { SettlementRowLike } from "./printUnification.server";
import { nonSalesFeeTotalFromSaved } from "./nonSalesFeeLines";

type AdminLike = { graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }> };

const LOCATION_QUERY = `#graphql
  query ReceiptLayoutLocation($id: ID!) {
    shop { name currencyCode }
    location(id: $id) { id name address { zip province provinceCode city address1 address2 phone countryCode } }
  }
`;

type Row = SettlementRowLike & { periodLabel?: string | null; createdAt?: Date | null };

export async function layoutSettlementHtml(
  admin: AdminLike,
  shopId: string,
  row: Row,
  layout: ReceiptLayout,
  opts: { currentLocationName: string; paperWidthMm: 58 | 80 },
): Promise<string | null> {
  const parsed = parsePaymentSectionsJson(row.paymentSectionsJson);
  const snapshot = parsed.snapshot;
  const isInspection = snapshot?.isInspection ?? String(row.periodLabel ?? "").startsWith("点検");
  const locationName = snapshot?.locationName?.trim() ? snapshot.locationName : opts.currentLocationName;
  const title = snapshot?.title?.trim() ? snapshot.title : settlementReceiptTitle(isInspection);
  // 点検も発行した時点の金額で行を保存する（#78）。古い点検の行は 0 のまま
  const printRow = row;
  const sectionsParsed = parsed.sections;

  let shop: { name?: string; currencyCode?: string } | null = null;
  let address: Parameters<typeof locationData>[1] = null;
  try {
    const res = await admin.graphql(LOCATION_QUERY, { variables: { id: row.locationId } });
    const json = (await res.json()) as {
      data?: { shop?: { name?: string; currencyCode?: string }; location?: { address?: Parameters<typeof locationData>[1] } | null };
    };
    shop = json.data?.shop ?? null;
    address = json.data?.location?.address ?? null;
  } catch {
    // 店の住所が読めなくても精算レシートは出す（住所のブロックが空になるだけ）
  }

  const [timezone, calc] = await Promise.all([
    getShopTimezoneForDaily(admin, shopId),
    getSettlementCalc(shopId),
  ]);
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const data = settlementTemplateData({
    figures: {
      total: n(printRow.total),
      netSales: n(printRow.netSales),
      tax: n(printRow.tax),
      discounts: n(printRow.discounts),
      vipPointsUsed: n(printRow.vipPointsUsed),
      refundTotal: n(printRow.refundTotal),
      orderCount: n(printRow.orderCount),
      refundCount: n(printRow.refundCount),
      itemCount: n(printRow.itemCount),
      voucherChangeAmount: n(printRow.voucherChangeAmount),
    },
    sections: sectionsParsed,
    isInspection,
    title,
    targetDate: row.targetDate,
    locationId: row.locationId,
    locationName,
    location: locationData(locationName, address),
    shopName: String(shop?.name ?? ""),
    currency: String(row.currency ?? shop?.currencyCode ?? "JPY"),
    issuedAt: row.createdAt?.toISOString() || "",
    printedAt: new Date().toISOString(),
    timezone,
    calc,
    // 今までの印字と同じ部品で出す（総売上 = 支払方法別の合計 − 売上に含めない送料等）
    nonSalesFee: nonSalesFeeTotalFromSaved(n(printRow.total), sectionsParsed),
  });
  return renderLayoutForPrint(layout, data, opts.paperWidthMm);
}
