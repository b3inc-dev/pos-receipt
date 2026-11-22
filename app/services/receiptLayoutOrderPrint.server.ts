/**
 * 販売レシート・ギフトレシートを、管理画面のレイアウト（#69）で作る
 * 注文を読むのはここだけ（LAYOUT_ORDER_QUERY）。注文・売上は作らない・変えない。
 */
import { getAppSetting } from "../utils/appSettings.server";
import { getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import { LAYOUT_ORDER_QUERY, salesTemplateData } from "./receiptLayoutAdapters";
import { renderLayoutForPrint } from "./receiptLayoutPrint.server";
import { normalizeSalesData, SALES_DATA_SETTING_KEY } from "./receiptLayoutSettlementCalc";
import type { ReceiptLayout } from "./receiptLayoutSchema";

type AdminLike = { graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> };

export type LayoutOrderResult =
  | { status: "ok"; html: string }
  | { status: "not_found" }
  /** 作れなかった（明細が 100 を超える・テンプレートの誤りなど）。今までの印字で出す */
  | { status: "fallback" };

const SHOP_LOGO_QUERY = `#graphql
  query ReceiptLayoutShopLogo { shop { brand { logo { image { url } } } } }
`;

/** ストアのロゴ（Shopify のブランドの設定）。読めなければ ""（印字は止めない） */
async function shopLogoUrl(admin: AdminLike): Promise<string> {
  try {
    const res = await admin.graphql(SHOP_LOGO_QUERY);
    const json = (await res.json()) as { data?: { shop?: { brand?: { logo?: { image?: { url?: string } } } } } };
    const url = String(json.data?.shop?.brand?.logo?.image?.url ?? "");
    return url.startsWith("https://") ? url : "";
  } catch {
    return "";
  }
}

export async function layoutOrderHtml(
  admin: AdminLike,
  shopId: string,
  orderGid: string,
  layout: ReceiptLayout,
  opts: { kind: "sales" | "gift"; paperWidthMm: 58 | 80; shopName?: string },
): Promise<LayoutOrderResult> {
  const res = await admin.graphql(LAYOUT_ORDER_QUERY, { variables: { id: orderGid } });
  const json = (await res.json()) as {
    errors?: unknown[];
    data?: { shop?: { name?: string; currencyCode?: string } | null; order?: Record<string, unknown> | null };
  };
  if (json.errors?.length) {
    console.warn("[receipt-layout] order query failed; falling back", { errors: json.errors.length });
    return { status: "fallback" };
  }
  const order = json.data?.order;
  if (!order) return { status: "not_found" };
  // 101 行目からを落として印字しない（ギフトは今の印字なら全部読む）
  if ((order.lineItems as { pageInfo?: { hasNextPage?: boolean } } | null)?.pageInfo?.hasNextPage) {
    return { status: "fallback" };
  }
  const usesShopLogo = layout.mode === "code"
    ? layout.code.includes("shop.logo_url")
    : layout.blocks.some((b) => !b.hidden && b.type === "logo" && b.settings.use_shop_logo === true && !b.settings.image_url);
  const [timezone, salesData, logoUrl] = await Promise.all([
    getShopTimezoneForDaily(admin as never, shopId),
    getAppSetting<unknown>(shopId, SALES_DATA_SETTING_KEY).then(normalizeSalesData),
    usesShopLogo ? shopLogoUrl(admin) : Promise.resolve(""),
  ]);
  const data = salesTemplateData({ shop: json.data?.shop, order }, opts.kind, {
    timezone,
    staffPropertyKeys: salesData.staffPropertyKeys,
    shopName: opts.shopName,
    printedAt: new Date().toISOString(),
    logoUrl,
  });
  const html = renderLayoutForPrint(layout, data, opts.paperWidthMm);
  return html ? { status: "ok", html } : { status: "fallback" };
}
