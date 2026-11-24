/** 互換URL: GETは統合画面へ。旧画面からのPOSTは保存互換のため維持。 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getAppSetting, setAppSetting, PRINT_SETTINGS_KEY, DEFAULT_PRINT_SETTINGS, SALES_RECEIPT_SETTINGS_KEY, DEFAULT_SALES_RECEIPT_SETTINGS, type PrintSettings, type SalesReceiptSettings } from "../utils/appSettings.server";
import prisma from "../db.server";
import { DEFAULT_TEMPLATE, normalizeTemplateData, type ReceiptTemplateData } from "../utils/receiptTemplateData";
import { syncPrintPaperWidthFields } from "../utils/printPaperWidth";
function formDataToTemplate(formData: FormData): ReceiptTemplateData {
  const get = (k: string) => formData.get(k);
  const getStr = (k: string, def = "") => String(get(k) ?? def).trim();
  const getBool = (k: string, def = true) => get(k) === "true" || (def && get(k) !== "false");
  const data: ReceiptTemplateData = {
    ...DEFAULT_TEMPLATE,
    receiptTemplateName: getStr("receiptTemplateName"),
    logoUrl: getStr("logoUrl") || null,
    companyName: getStr("companyName"),
    postalCode: getStr("postalCode"),
    address: getStr("address"),
    address2: getStr("address2"),
    phone: getStr("phone"),
    showIssueDate: getBool("showIssueDate"),
    showOrderName: getBool("showOrderName"),
    showLocationName: getBool("showLocationName"),
    showCustomerName: getBool("showCustomerName"),
    showProviso: getBool("showProviso"),
    showAmount: getBool("showAmount"),
    showTaxNote: getBool("showTaxNote"),
    showReissueMark: getBool("showReissueMark"),
    defaultProviso: getStr("defaultProviso", "お買上品代として"),
    defaultRecipientSuffix: getStr("defaultRecipientSuffix", "様"),
    headerAlignment: (getStr("headerAlignment") || "center") as "left" | "center" | "right",
    logoPosition: (getStr("logoPosition") || "top") as "top" | "inline",
    companyInfoPosition: (getStr("companyInfoPosition") || "bottom") as "top" | "bottom",
    amountEmphasisMode: (getStr("amountEmphasisMode") || "normal") as "normal" | "emphasis",
    bodySpacing: (getStr("bodySpacing") || "normal") as "compact" | "normal" | "relaxed",
    receiptTitle: getStr("receiptTitle", "領収書"),
    reissueLabel: getStr("reissueLabel", "再発行"),
    taxNoteLabel: getStr("taxNoteLabel", "（税込）"),
    currencyPrefix: getStr("currencyPrefix", "¥"),
  };
  data.showOrderNumber = data.showOrderName;
  data.showDate = data.showIssueDate;
  return data;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return redirect("/app/receipt-layouts/receipt" + new URL(request.url).search);
}
export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const formData = await request.formData();
  const data = formDataToTemplate(formData);

  const existing = await prisma.receiptTemplate.findFirst({
    where: { shopId: shop.id, isActive: true },
    orderBy: { updatedAt: "desc" },
  });

  if (existing) {
    await prisma.receiptTemplate.update({
      where: { id: existing.id },
      data: {
        templateJson: JSON.stringify(data),
        version: { increment: 1 },
        updatedAt: new Date(),
      },
    });
  } else {
    await prisma.receiptTemplate.create({
      data: {
        shopId: shop.id,
        name: data.receiptTemplateName || "デフォルトテンプレート",
        isActive: true,
        templateJson: JSON.stringify(data),
        version: 1,
      },
    });
  }

  return Response.json({ ok: true });
}

export default function ReceiptDesignRedirect() { return null; }
