/**
 * GET /api/print/receipt/:id
 * 領収書 HTML（Shopify Printing API の src）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  authenticatePosRequestOrCorsError,
  corsErrorJson,
  corsHtml,
  corsPreflightResponse,
} from "../utils/posAuth.server";
import prisma from "../db.server";
import { renderPrintReceiptHtml, type PrintAttr } from "../services/printReceiptHtml";
import { SALES_RECEIPT_ORDER_QUERY } from "../services/salesReceiptPrint.server";
import {
  DEFAULT_TEMPLATE,
  normalizeTemplateData,
  type ReceiptTemplateData,
} from "./api.settings.receipt-template";
import {
  getAppSetting,
  PRINT_SETTINGS_KEY,
  DEFAULT_PRINT_SETTINGS,
  type PrintSettings,
} from "../utils/appSettings.server";
import { loadSalesReceiptAttrFlags } from "../utils/loadSalesReceiptAttrFlags.server";

function mapAttrs(raw: { key?: string; value?: string }[] | null | undefined): PrintAttr[] {
  return (raw ?? [])
    .map((a) => ({ key: String(a.key ?? ""), value: String(a.value ?? "") }))
    .filter((a) => a.key || a.value);
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop } = authResult;
    const id = params.id;
    if (!id) {
      return corsErrorJson(request, { ok: false, error: "id is required" }, 400);
    }

    const issued = await prisma.receiptIssue.findFirst({
      where: { id, shopId: shop.id },
    });
    if (!issued) {
      return corsHtml(
        request,
        `<!DOCTYPE html><html><body><p>領収書が見つかりません。</p></body></html>`,
        { status: 404 },
      );
    }

    let templateData: ReceiptTemplateData = normalizeTemplateData({ ...DEFAULT_TEMPLATE });
    if (issued.templateId) {
      const tmpl = await prisma.receiptTemplate.findFirst({
        where: { id: issued.templateId, shopId: shop.id },
      });
      if (tmpl?.templateJson) {
        templateData = normalizeTemplateData(
          JSON.parse(tmpl.templateJson) as Record<string, unknown>,
        );
      }
    } else {
      const tmpl = await prisma.receiptTemplate.findFirst({
        where: { shopId: shop.id, isActive: true },
        orderBy: { updatedAt: "desc" },
      });
      if (tmpl?.templateJson) {
        templateData = normalizeTemplateData(
          JSON.parse(tmpl.templateJson) as Record<string, unknown>,
        );
      }
    }

    const location = issued.locationId
      ? await prisma.location.findFirst({
          where: { shopId: shop.id, shopifyLocationGid: issued.locationId },
        })
      : null;

    const printSettings =
      (await getAppSetting<Partial<PrintSettings>>(shop.id, PRINT_SETTINGS_KEY)) ?? {};
    const paper =
      (printSettings.cloudprntPaperWidth ?? DEFAULT_PRINT_SETTINGS.cloudprntPaperWidth) === "58mm"
        ? 58
        : 80;

    const attrFlags = await loadSalesReceiptAttrFlags(shop.id);
    let orderAttributes: PrintAttr[] = [];
    let lineAttributes: PrintAttr[] = [];
    if (
      issued.orderId &&
      (attrFlags.printOrderAttributes || attrFlags.printLineAttributes)
    ) {
      try {
        const orderGid = issued.orderId.startsWith("gid://")
          ? issued.orderId
          : `gid://shopify/Order/${issued.orderId}`;
        const res = await admin.graphql(SALES_RECEIPT_ORDER_QUERY, {
          variables: { id: orderGid },
        });
        const json = (await res.json()) as {
          data?: {
            order?: {
              customAttributes?: { key?: string; value?: string }[];
              lineItems?: {
                nodes?: { customAttributes?: { key?: string; value?: string }[] }[];
              };
            };
          };
        };
        const order = json.data?.order;
        if (order) {
          if (attrFlags.printOrderAttributes) {
            orderAttributes = mapAttrs(order.customAttributes);
          }
          if (attrFlags.printLineAttributes) {
            const nodes = order.lineItems?.nodes ?? [];
            lineAttributes = nodes.flatMap((li) => mapAttrs(li.customAttributes));
          }
        }
      } catch {
        // 属性取得失敗でも領収書本体は印字する
      }
    }

    const html = renderPrintReceiptHtml({
      kind: "receipt",
      title: "領　収　書",
      recipientName: issued.recipientName ?? "",
      proviso: issued.proviso ?? (templateData as { defaultProviso?: string }).defaultProviso ?? "お買上品代として",
      amount: Number(issued.amount),
      currency: issued.currency ?? "JPY",
      issueDate: issued.createdAt.toISOString().slice(0, 10),
      orderName: issued.orderName ?? undefined,
      locationName: location?.displayName ?? location?.name ?? "",
      companyName: templateData.companyName,
      address: templateData.address,
      phone: templateData.phone,
      showOrderNumber: Boolean(
        (templateData as { showOrderNumber?: boolean }).showOrderNumber ??
          templateData.showOrderName,
      ),
      showDate: Boolean(
        (templateData as { showDate?: boolean }).showDate ?? templateData.showIssueDate,
      ),
      showOrderAttributes: attrFlags.printOrderAttributes,
      showLineAttributes: attrFlags.printLineAttributes,
      orderAttributes,
      lineAttributes,
      paperWidthMm: paper,
    });
    return corsHtml(request, html);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
