/**
 * 販売レシート・ギフトレシートを、管理画面のレイアウト（#69）で作る
 * 注文を読むのはここだけ（LAYOUT_ORDER_QUERY）。注文・売上は作らない・変えない。
 */
import { getAppSetting } from "../utils/appSettings.server";
import { getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import { LAYOUT_ORDER_QUERY, LAYOUT_SHIPPING_ADDRESS_QUERY, salesTemplateData } from "./receiptLayoutAdapters";
import { renderLayoutForPrint } from "./receiptLayoutPrint.server";
import { normalizeSalesData, SALES_DATA_SETTING_KEY } from "./receiptLayoutSettlementCalc";
import type { ReceiptLayout } from "./receiptLayoutSchema";
import { applyPrintMarksToLayoutHtml, printMarkTemplateValues } from "./printMarks";

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

/** 配送先（保護されたお客様のデータ）。読めなければ null */
async function shippingAddress(admin: AdminLike, orderGid: string): Promise<unknown> {
  try {
    const res = await admin.graphql(LAYOUT_SHIPPING_ADDRESS_QUERY, { variables: { id: orderGid } });
    const json = (await res.json()) as { data?: { order?: { shippingAddress?: unknown } | null } };
    return json.data?.order?.shippingAddress ?? null;
  } catch {
    return null;
  }
}

/**
 * Shopify の答えに errors があると admin.graphql は例外を投げる。
 * ここで起きた失敗はどれも fallback（今までの印字で出す）にして、印字そのものは止めない。
 */
export async function layoutOrderHtml(
  admin: AdminLike,
  shopId: string,
  orderGid: string,
  layout: ReceiptLayout,
  opts: { kind: "sales" | "gift"; paperWidthMm: 58 | 80; shopName?: string; printMarks?: string[]; isReprint?: boolean },
): Promise<LayoutOrderResult> {
  try {
    return await build(admin, shopId, orderGid, layout, opts);
  } catch (e) {
    console.warn("[receipt-layout] order print failed; falling back", {
      kind: opts.kind,
      error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
    });
    return { status: "fallback" };
  }
}

async function build(
  admin: AdminLike,
  shopId: string,
  orderGid: string,
  layout: ReceiptLayout,
  opts: { kind: "sales" | "gift"; paperWidthMm: 58 | 80; shopName?: string; printMarks?: string[]; isReprint?: boolean },
): Promise<LayoutOrderResult> {
  const res = await admin.graphql(LAYOUT_ORDER_QUERY, { variables: { id: orderGid } });
  const json = (await res.json()) as {
    errors?: unknown[];
    data?: { shop?: { name?: string; currencyCode?: string } | null; order?: Record<string, unknown> | null };
  };
  if (json.errors?.length) return { status: "fallback" };
  const order = json.data?.order;
  if (!order) return { status: "not_found" };
  // 101 行目からを落として印字しない（ギフトは今の印字なら全部読む）
  if ((order.lineItems as { pageInfo?: { hasNextPage?: boolean } } | null)?.pageInfo?.hasNextPage) {
    return { status: "fallback" };
  }
  const usesShopLogo = layout.mode === "code"
    ? layout.code.includes("shop.logo_url")
    : layout.blocks.some((b) => !b.hidden && b.type === "logo" && b.settings.use_shop_logo === true && !b.settings.image_url);
  // ギフトレシートに配送先は要らない
  const [timezone, salesData, logoUrl, ship] = await Promise.all([
    getShopTimezoneForDaily(admin as never, shopId),
    getAppSetting<unknown>(shopId, SALES_DATA_SETTING_KEY).then(normalizeSalesData),
    usesShopLogo ? shopLogoUrl(admin) : Promise.resolve(""),
    opts.kind === "sales" ? shippingAddress(admin, orderGid) : Promise.resolve(null),
  ]);
  const data = salesTemplateData({ shop: json.data?.shop, order: { ...order, shippingAddress: ship } }, opts.kind, {
    timezone,
    staffPropertyKeys: salesData.staffPropertyKeys,
    shopName: opts.shopName,
    printedAt: new Date().toISOString(),
    logoUrl,
  });
  // 再印字の印（印字設定でオンにした店だけ）。レイアウトに印のブロックが無ければ上に出す
  const withMarks = { ...data, ...printMarkTemplateValues(opts.printMarks ?? [], !!opts.isReprint) };
  const html = renderLayoutForPrint(layout, withMarks, opts.paperWidthMm);
  return html
    ? { status: "ok", html: applyPrintMarksToLayoutHtml(html, layout, opts.printMarks ?? []) }
    : { status: "fallback" };
}
