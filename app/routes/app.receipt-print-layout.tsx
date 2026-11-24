/** 互換URL: GETは統合画面へ。旧画面からのPOSTは保存互換のため維持。 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getAppSetting, setAppSetting, PRINT_SETTINGS_KEY, DEFAULT_PRINT_SETTINGS, SALES_RECEIPT_SETTINGS_KEY, DEFAULT_SALES_RECEIPT_SETTINGS, type PrintSettings, type SalesReceiptSettings } from "../utils/appSettings.server";
import prisma from "../db.server";
import { DEFAULT_TEMPLATE, normalizeTemplateData, type ReceiptTemplateData } from "../utils/receiptTemplateData";
import { syncPrintPaperWidthFields } from "../utils/printPaperWidth";
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return redirect("/app/receipt-layouts/receipt" + new URL(request.url).search);
}
export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);
  const formData = await request.formData();
  const get = (k: string) => formData.get(k);
  const bool = (k: string) => get(k) === "true";
  const str = (k: string, d: string) => String(get(k) ?? d);

  const existing = await prisma.receiptTemplate.findFirst({
    where: { shopId: shop.id, isActive: true },
    orderBy: { updatedAt: "desc" },
  });
  const prev = normalizeTemplateData(
    existing
      ? (JSON.parse(existing.templateJson) as Record<string, unknown>)
      : { ...DEFAULT_TEMPLATE },
  );
  const next: ReceiptTemplateData = {
    ...prev,
    companyName: str("companyName", prev.companyName),
    address: str("address", prev.address),
    phone: str("phone", prev.phone),
    defaultProviso: str("defaultProviso", prev.defaultProviso),
    receiptTitle: str("receiptTitle", prev.receiptTitle || "領収書"),
    showOrderName: bool("showOrderName"),
    showIssueDate: bool("showIssueDate"),
    showLocationName: bool("showLocationName"),
  };
  next.showOrderNumber = next.showOrderName;
  next.showDate = next.showIssueDate;

  if (existing) {
    await prisma.receiptTemplate.update({
      where: { id: existing.id },
      data: {
        templateJson: JSON.stringify(next),
        version: (existing.version ?? 1) + 1,
        updatedAt: new Date(),
      },
    });
  } else {
    await prisma.receiptTemplate.create({
      data: {
        shopId: shop.id,
        name: "デフォルトテンプレート",
        templateJson: JSON.stringify(next),
        version: 1,
        isActive: true,
      },
    });
  }

  const paperWidthMm: 58 | 80 = str("paperWidthMm", "80") === "58" ? 58 : 80;
  const printSettings = {
    ...DEFAULT_PRINT_SETTINGS,
    ...((await getAppSetting<Partial<PrintSettings>>(shop.id, PRINT_SETTINGS_KEY)) ?? {}),
    ...syncPrintPaperWidthFields(paperWidthMm),
  };
  await setAppSetting(shop.id, PRINT_SETTINGS_KEY, printSettings);
  return Response.json({ ok: true });
}

export default function ReceiptDesignRedirect() { return null; }
