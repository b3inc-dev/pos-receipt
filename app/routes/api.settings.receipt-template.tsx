/**
 * GET  /api/settings/receipt-template  → テンプレート取得
 * POST /api/settings/receipt-template  → テンプレート更新
 * 要件書 §8.3, §21.7, §24.1
 */
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";

import { DEFAULT_TEMPLATE, normalizeTemplateData, type ReceiptTemplateData } from "../utils/receiptTemplateData";
export { DEFAULT_TEMPLATE, normalizeTemplateData, type ReceiptTemplateData } from "../utils/receiptTemplateData";

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
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;

    const template = await getOrCreateTemplate(shop.id);
    const data = normalizeTemplateData(JSON.parse(template.templateJson) as Record<string, unknown>);

    return corsJson({
      templateId: template.id,
      version: template.version,
      data,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;
    if (request.method !== "POST") {
      return corsJson({ error: "Method not allowed" }, { status: 405 });
    }

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
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
