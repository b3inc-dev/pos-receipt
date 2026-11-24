/** 互換URL: GETは統合画面へ。旧画面からのPOSTは保存互換のため維持。 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getAppSetting, setAppSetting, PRINT_SETTINGS_KEY, DEFAULT_PRINT_SETTINGS, SALES_RECEIPT_SETTINGS_KEY, DEFAULT_SALES_RECEIPT_SETTINGS, type PrintSettings, type SalesReceiptSettings } from "../utils/appSettings.server";
import { syncPrintPaperWidthFields } from "../utils/printPaperWidth";
const PREVIEW_KEY = "settlement_print_layout_preview";
type SettlementPreviewPrefs = { isInspection: boolean; showVoucherChange: boolean; paperWidthMm: 58 | 80 };
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return redirect("/app/receipt-layouts/settlement" + new URL(request.url).search);
}
export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const prefs: SettlementPreviewPrefs = {
    isInspection: formData.get("isInspection") === "true",
    showVoucherChange: formData.get("showVoucherChange") === "true",
    paperWidthMm: formData.get("paperWidthMm") === "58" ? 58 : 80,
  };
  await setAppSetting(shop.id, PREVIEW_KEY, prefs);

  // 用紙幅は印字設定にも反映（paperWidthMm ↔ cloudprntPaperWidth 同期）
  const printSettings = {
    ...DEFAULT_PRINT_SETTINGS,
    ...((await getAppSetting<Partial<PrintSettings>>(shop.id, PRINT_SETTINGS_KEY)) ?? {}),
    ...syncPrintPaperWidthFields(prefs.paperWidthMm),
  };
  await setAppSetting(shop.id, PRINT_SETTINGS_KEY, printSettings);
  return Response.json({ ok: true });
}

export default function ReceiptDesignRedirect() { return null; }
