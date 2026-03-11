/**
 * GET  /api/settings/receipt-template  → テンプレート取得
 * POST /api/settings/receipt-template  → テンプレート更新
 * 要件書 §8.3, §21.7, §24.1
 */
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticatePosRequest } from "../utils/posAuth.server";
import prisma from "../db.server";

/** 領収書テンプレートのデフォルト値（要件 §9.2） */
export const DEFAULT_TEMPLATE = {
  // §9.2.1 基本情報
  receiptTemplateName: "",
  logoUrl: null as string | null,
  companyName: "",
  postalCode: "",
  address: "",
  address2: "",
  phone: "",
  // §9.2.2 表示項目
  showIssueDate: true,
  showOrderName: true,
  showLocationName: true,
  showCustomerName: true,
  showProviso: true,
  showAmount: true,
  showTaxNote: true,
  showReissueMark: true,
  // §9.2.3 デフォルト値
  defaultProviso: "お買上品代として",
  defaultRecipientSuffix: "様",
  // §9.2.4 レイアウト（MVP はシンプルな値）
  headerAlignment: "center" as "left" | "center" | "right",
  logoPosition: "top" as "top" | "inline",
  companyInfoPosition: "bottom" as "top" | "bottom",
  amountEmphasisMode: "normal" as "normal" | "emphasis",
  bodySpacing: "normal" as "compact" | "normal" | "relaxed",
  // §9.2.5 文言
  receiptTitle: "領収書",
  reissueLabel: "再発行",
  taxNoteLabel: "（税込）",
  currencyPrefix: "¥",
  // 後方互換のエイリアス（既存データ用）
  showOrderNumber: true,
  showDate: true,
};

export type ReceiptTemplateData = typeof DEFAULT_TEMPLATE;

/** 既存 templateJson（旧キー含む）を §9.2 の型に正規化（管理画面 loader でも使用） */
export function normalizeTemplateData(partial: Record<string, unknown> | null): ReceiptTemplateData {
  const data = { ...DEFAULT_TEMPLATE, ...partial } as ReceiptTemplateData;
  if (partial && "showOrderNumber" in partial) data.showOrderName = !!partial.showOrderNumber;
  if (partial && "showDate" in partial) data.showIssueDate = !!partial.showDate;
  data.showOrderNumber = data.showOrderName;
  data.showDate = data.showIssueDate;
  return data;
}

async function getOrCreateTemplate(shopId: string) {
  const existing = await prisma.receiptTemplate.findFirst({
    where: { shopId, isActive: true },
    orderBy: { updatedAt: "desc" },
  });
  if (existing) return existing;

  return prisma.receiptTemplate.create({
    data: {
      shopId,
      name: "デフォルトテンプレート",
      isActive: true,
      templateJson: JSON.stringify(DEFAULT_TEMPLATE),
      version: 1,
    },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { admin, shop, corsJson } = await authenticatePosRequest(request);

    const template = await getOrCreateTemplate(shop.id);
    const data = normalizeTemplateData(JSON.parse(template.templateJson) as Record<string, unknown>);

    return corsJson({
      templateId: template.id,
      version: template.version,
      data,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsJson({ ok: false, error: message }, { status: 500 });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return corsJson({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const { admin, shop, corsJson } = await authenticatePosRequest(request);

    const body = await request.json() as Partial<ReceiptTemplateData>;

    const existing = await getOrCreateTemplate(shop.id);
    const currentData = normalizeTemplateData(JSON.parse(existing.templateJson) as Record<string, unknown>);
    const newData: ReceiptTemplateData = { ...currentData, ...body };
    newData.showOrderNumber = newData.showOrderName;
    newData.showDate = newData.showIssueDate;

    const updated = await prisma.receiptTemplate.update({
      where: { id: existing.id },
      data: {
        templateJson: JSON.stringify(newData),
        version: { increment: 1 },
      },
    });

    return corsJson({
      ok: true,
      templateId: updated.id,
      version: updated.version,
      data: newData,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsJson({ ok: false, error: message }, { status: 500 });
  }
}
