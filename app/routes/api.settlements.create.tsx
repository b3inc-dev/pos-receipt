/**
 * POST /api/settlements/create
 * 要件書 §21.3: 精算実行・保存
 *
 * - cloudprnt_direct: 集計してDB保存 → printable payload を返す
 * - order_based: 集計 → Shopify精算注文作成 → DB保存
 * - isInspection=true: 点検レシート（DB保存するが periodLabel に "点検_" プレフィックス）
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticatePosRequest } from "../utils/posAuth.server";
import prisma from "../db.server";
import { buildSettlementPreview, type SettlementPreviewDTO } from "../services/settlementEngine.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return corsJson({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const { admin, shop, corsJson } = await authenticatePosRequest(request);

    const body = await request.json() as Record<string, unknown>;
    const { locationId, locationName, targetDate, printMode, isInspection } = body;

    if (!locationId || !targetDate || !printMode) {
      return corsJson(
        { ok: false, error: "locationId, targetDate, printMode are required" },
        { status: 400 }
      );
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

    // order_based: Shopify精算注文を作成（点検レシートは作成しない）
    if (String(printMode) === "order_based" && !isInspection) {
      const result = await createSettlementOrder(admin, preview);
      sourceOrderId = result.orderId;
      sourceOrderName = result.orderName;
    }

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
      },
    });

    return corsJson(
      {
        ok: true,
        settlementId: settlement.id,
        preview,
        sourceOrderId,
        sourceOrderName,
        printMode,
        isInspection: Boolean(isInspection),
      },
      { status: 201 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsJson({ ok: false, error: message }, { status: 500 });
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
  // 精算レシート用のノート文字列
  const noteLines = [
    "【精算レシート】",
    `日付: ${preview.targetDate}`,
    `ロケーション: ${preview.locationName}`,
    "─────────────────",
    `総売上: ¥${preview.total.toLocaleString()}`,
    `純売上: ¥${preview.netSales.toLocaleString()}`,
    `消費税: ¥${preview.tax.toLocaleString()}`,
    `割引: ¥${preview.discounts.toLocaleString()}`,
    `返金: ¥${preview.refundTotal.toLocaleString()}`,
    `件数: ${preview.orderCount}件 (返金${preview.refundCount}件)`,
    `点数: ${preview.itemCount}点`,
    ...(preview.voucherChangeAmount > 0
      ? [`商品券釣有り差額: ¥${preview.voucherChangeAmount.toLocaleString()}`]
      : []),
    "─────────────────",
    ...preview.paymentSections.map(
      (s) => `${s.label}: ¥${s.net.toLocaleString()} (返金¥${s.refund.toLocaleString()})`
    ),
  ].join("\n");

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
