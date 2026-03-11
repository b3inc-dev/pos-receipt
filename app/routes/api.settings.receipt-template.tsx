/**
 * GET  /api/settings/receipt-template  → テンプレート取得
 * POST /api/settings/receipt-template  → テンプレート更新
 * 要件書 §8.3, §21.7, §24.1
 */
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticatePosRequest } from "../utils/posAuth.server";
import prisma from "../db.server";

const TEMPLATE_KEY = "receipt_template";

export const DEFAULT_TEMPLATE = {
  companyName: "",
  address: "",
  phone: "",
  defaultProviso: "お買上品代として",
  showOrderNumber: true,
  showDate: true,
  logoUrl: null as string | null,
};

export type ReceiptTemplateData = typeof DEFAULT_TEMPLATE;

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
    const data: ReceiptTemplateData = {
      ...DEFAULT_TEMPLATE,
      ...(JSON.parse(template.templateJson) as Partial<ReceiptTemplateData>),
    };

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
    const currentData: ReceiptTemplateData = {
      ...DEFAULT_TEMPLATE,
      ...(JSON.parse(existing.templateJson) as Partial<ReceiptTemplateData>),
    };
    const newData: ReceiptTemplateData = { ...currentData, ...body };

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
