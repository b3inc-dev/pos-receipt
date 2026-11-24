/** 互換URL: GETは統合画面へ。旧画面からのPOSTは保存互換のため維持。 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getAppSetting, setAppSetting, PRINT_SETTINGS_KEY, DEFAULT_PRINT_SETTINGS, SALES_RECEIPT_SETTINGS_KEY, DEFAULT_SALES_RECEIPT_SETTINGS, type PrintSettings, type SalesReceiptSettings } from "../utils/appSettings.server";
import { GIFT_LAYOUT_KEY } from "../utils/salesReceiptSettings";
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return redirect("/app/receipt-layouts/sales" + new URL(request.url).search);
}
export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const get = (k: string) => formData.get(k);
  const bool = (k: string) => get(k) === "true";
  const str = (k: string, d: string) => String(get(k) ?? d);
  const settings: SalesReceiptSettings = {
    enabled: bool("enabled"),
    printOrderAttributes: bool("printOrderAttributes"),
    printLineAttributes: bool("printLineAttributes"),
    paperWidthMm: str("paperWidthMm", "80") === "58" ? 58 : 80,
    headerTitle: str("headerTitle", DEFAULT_SALES_RECEIPT_SETTINGS.headerTitle),
    footerNote: str("footerNote", DEFAULT_SALES_RECEIPT_SETTINGS.footerNote),
    layoutJson: {
      showSku: bool("showSku"),
      showPayments: bool("showPayments"),
      showLocation: bool("showLocation"),
    },
  };
  await setAppSetting(shop.id, SALES_RECEIPT_SETTINGS_KEY, settings);
  return Response.json({ ok: true });
}

export default function ReceiptDesignRedirect() { return null; }
