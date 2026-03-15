/**
 * POST /api/settlements/create
 * 要件書 §21.3: 精算実行・保存
 *
 * - cloudprnt_direct: 集計してDB保存 → printable payload を返す
 * - order_based: 集計 → Shopify精算注文作成 → DB保存
 * - isInspection=true: 点検レシート（DB保存するが periodLabel に "点検_" プレフィックス）
 *
 * リトライ安全: locationId+targetDate+printMode のハッシュを idempotencyKey として使用。
 * 同一キーが既存の場合は重複精算を作成せず既存レコードを返す（点検レシートは除外）。
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import { buildSettlementPreview, buildSettlementReceiptText, type SettlementPreviewDTO } from "../services/settlementEngine.server";

/** locationId + targetDate + printMode から冪等キーを生成 */
function buildIdempotencyKey(
  shopId: string,
  locationId: string,
  targetDate: string,
  printMode: string,
): string {
  return `${shopId}:${locationId}:${targetDate}:${printMode}`;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;

    const body = await request.json() as Record<string, unknown>;
    const { locationId, locationName, targetDate, printMode, isInspection } = body;

    if (!locationId || !targetDate || !printMode) {
      return corsJson(
        { ok: false, error: "locationId, targetDate, printMode are required" },
        { status: 400 }
      );
    }

    // ── 冪等性チェック（点検レシートは対象外） ──────────────────────────────
    if (!isInspection) {
      const idemKey = buildIdempotencyKey(
        shop.id, String(locationId), String(targetDate), String(printMode)
      );
      const existingSettlement = await prisma.settlement.findUnique({
        where: { idempotencyKey: idemKey },
      });
      if (existingSettlement) {
        return corsJson(
          {
            ok: true,
            idempotent: true,
            settlementId: existingSettlement.id,
            preview: null,
            sourceOrderId: existingSettlement.sourceOrderId,
            sourceOrderName: existingSettlement.sourceOrderName,
            printMode: existingSettlement.printMode,
            isInspection: false,
          },
          { status: 200 }
        );
      }
    }

    const preview = await buildSettlementPreview(
      admin,
      shop.id,
      String(locationId),
      String(locationName ?? ""),
      String(targetDate),
    );

    let sourceOrderId: string | null = null;
    let sourceOrderName: string | null = null;

    // ガイド 8.1: order_based のときのみ精算注文を生成。cloudprnt_direct のときは生成しない。点検レシートは作成しない。
    if (String(printMode) === "order_based" && !isInspection) {
      const result = await createSettlementOrder(admin, preview);
      sourceOrderId = result.orderId;
      sourceOrderName = result.orderName;
    }

    const idemKey = !isInspection
      ? buildIdempotencyKey(shop.id, String(locationId), String(targetDate), String(printMode))
      : null;

    const settlement = await prisma.settlement.create({
      data: {
        shopId: shop.id,
        locationId: String(locationId),
        sourceOrderId,
        sourceOrderName,
        targetDate: String(targetDate),
        periodLabel: isInspection ? `点検_${String(targetDate)}` : String(targetDate),
        currency: preview.currency,
        total: preview.total,
        netSales: preview.netSales,
        tax: preview.tax,
        discounts: preview.discounts,
        vipPointsUsed: preview.vipPointsUsed,
        refundTotal: preview.refundTotal,
        orderCount: preview.orderCount,
        refundCount: preview.refundCount,
        itemCount: preview.itemCount,
        voucherChangeAmount: preview.voucherChangeAmount,
        paymentSectionsJson: JSON.stringify(preview.paymentSections),
        printMode: String(printMode),
        status: "completed",
        idempotencyKey: idemKey,
      },
    });

    // cloudprnt_direct 時は印字用 payload（テキスト）を返す。CloudPRNT 実機連携で利用。
    const printPayload =
      String(printMode) === "cloudprnt_direct" ? buildSettlementReceiptText(preview) : undefined;

    return corsJson(
      {
        ok: true,
        idempotent: false,
        settlementId: settlement.id,
        preview,
        sourceOrderId,
        sourceOrderName,
        printMode,
        isInspection: Boolean(isInspection),
        ...(printPayload !== undefined && { printPayload }),
      },
      { status: 201 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

// ── Shopify精算注文作成（order_based印字用） ──────────────────────────────────

const DRAFT_ORDER_CREATE = `#graphql
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name }
      userErrors { field message }
    }
  }
`;

const DRAFT_ORDER_COMPLETE = `#graphql
  mutation DraftOrderComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder { order { id name } }
      userErrors { field message }
    }
  }
`;

async function createSettlementOrder(
  admin: { graphql: (q: string, opts?: object) => Promise<{ json: () => Promise<unknown> }> },
  preview: SettlementPreviewDTO,
): Promise<{ orderId: string; orderName: string }> {
  const noteLines = buildSettlementReceiptText(preview);

  const createRes = await admin.graphql(DRAFT_ORDER_CREATE, {
    variables: {
      input: {
        lineItems: [{ title: "精算", quantity: 1, originalUnitPrice: "0" }],
        note: noteLines,
        tags: ["settlement", `settlement-${preview.targetDate}`],
        customAttributes: [
          { key: "settlement_date", value: preview.targetDate },
          { key: "settlement_location", value: preview.locationName },
          { key: "settlement_total", value: String(preview.total) },
        ],
      },
    },
  });

  const createJson = await createRes.json() as {
    data?: {
      draftOrderCreate?: {
        draftOrder?: { id: string; name: string };
        userErrors: { message: string }[];
      };
    };
  };

  const draftOrder = createJson.data?.draftOrderCreate?.draftOrder;
  if (!draftOrder) {
    const errors = createJson.data?.draftOrderCreate?.userErrors ?? [];
    throw new Error(`精算注文の作成に失敗しました: ${errors.map((e) => e.message).join(", ")}`);
  }

  const completeRes = await admin.graphql(DRAFT_ORDER_COMPLETE, {
    variables: { id: draftOrder.id },
  });

  const completeJson = await completeRes.json() as {
    data?: {
      draftOrderComplete?: {
        draftOrder?: { order?: { id: string; name: string } };
        userErrors: { message: string }[];
      };
    };
  };

  const completedOrder = completeJson.data?.draftOrderComplete?.draftOrder?.order;
  if (completedOrder) {
    return { orderId: completedOrder.id, orderName: completedOrder.name };
  }

  // フォールバック: ドラフト注文 ID を返す
  return { orderId: draftOrder.id, orderName: draftOrder.name };
}
