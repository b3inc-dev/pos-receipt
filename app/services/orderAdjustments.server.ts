/**
 * 特殊返金・商品券調整を注文メタフィールド `pos.adjustments` に書く／読む（docs/ORDER_ADJUSTMENTS_METAFIELD.md）。
 * 値は毎回、その注文の DB の行（全部）から作り直してまるごと書く。書けなくても登録は取り消さず、
 * 行に metafieldSyncError を残す（精算は警告を出し、次の書き込みで直る）。
 */
import prisma from "../db.server";
import { adminGraphqlWithRetry, type AdminGraphqlClient } from "../lib/shopifyGraphqlThrottle.server";
import { getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import {
  ORDER_ADJUSTMENTS_KEY,
  ORDER_ADJUSTMENTS_NAMESPACE,
  ORDER_ADJUSTMENTS_SUMMARY_KEY,
  buildOrderAdjustmentsDoc,
  buildOrderAdjustmentsSummary,
  toOrderGid,
  voucherAppliedFromTransactions,
  type OrderAdjustmentsDoc,
} from "./orderAdjustmentsPure.server";

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

const METAFIELDS_SET = `#graphql
  mutation OrderAdjustmentsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key namespace }
      userErrors { field message code }
    }
  }
`;

const ORDER_ADJUSTMENTS_DOCS_QUERY = `#graphql
  query OrderAdjustmentsDocs($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        adjustments: metafield(namespace: "pos", key: "adjustments") { value }
      }
    }
  }
`;

/** 支払方法マスタの gateway の名前 → 表示名 */
async function loadMethodLabels(shopId: string): Promise<(m: string) => string | null> {
  const rows = await prisma.paymentMethodMaster.findMany({
    where: { shopId },
    select: { rawGatewayPattern: true, displayLabel: true },
  });
  const map = new Map<string, string>();
  for (const r of rows) {
    const k = String(r.rawGatewayPattern ?? "").trim().toLowerCase();
    if (k && r.displayLabel) map.set(k, r.displayLabel);
  }
  return (m: string) => map.get(String(m).trim().toLowerCase()) ?? null;
}

export type OrderAdjustmentsSyncResult =
  | { ok: true; doc: OrderAdjustmentsDoc; summary: string }
  | { ok: false; error: string };

/** その注文の DB の行から値を作る（書かない）。注文ページのブロックの表示にも使う */
export async function buildOrderAdjustmentsDocForOrder(
  admin: AdminClient,
  shopId: string,
  sourceOrderId: string,
): Promise<{ doc: OrderAdjustmentsDoc; summary: string; timeZone: string }> {
  const orderGid = toOrderGid(sourceOrderId);
  const digits = orderGid.replace(/\D/g, "");
  const [rows, timeZone, labelOf] = await Promise.all([
    prisma.specialRefundEvent.findMany({
      where: { shopId, sourceOrderId: { in: [orderGid, digits, sourceOrderId] } },
      orderBy: { createdAt: "asc" },
    }),
    getShopTimezoneForDaily(admin, shopId),
    loadMethodLabels(shopId),
  ]);
  const doc = buildOrderAdjustmentsDoc(rows, { timeZone, labelOf });
  return { doc, summary: buildOrderAdjustmentsSummary(doc), timeZone };
}

/**
 * 注文メタフィールドを DB の行から書き直す。失敗しても throw しない（登録は取り消さない）。
 * 書けた・書けなかったは、その注文の行の metafieldSyncedAt / metafieldSyncError に残す。
 */
export async function syncOrderAdjustmentsMetafield(
  admin: AdminClient,
  shopId: string,
  sourceOrderId: string,
): Promise<OrderAdjustmentsSyncResult> {
  const orderGid = toOrderGid(sourceOrderId);
  const digits = orderGid.replace(/\D/g, "");
  const orderIdVariants = [...new Set([orderGid, digits, sourceOrderId])];
  try {
    const { doc, summary } = await buildOrderAdjustmentsDocForOrder(admin, shopId, sourceOrderId);
    const res = await admin.graphql(METAFIELDS_SET, {
      variables: {
        metafields: [
          {
            ownerId: orderGid,
            namespace: ORDER_ADJUSTMENTS_NAMESPACE,
            key: ORDER_ADJUSTMENTS_KEY,
            type: "json",
            value: JSON.stringify(doc),
          },
          {
            ownerId: orderGid,
            namespace: ORDER_ADJUSTMENTS_NAMESPACE,
            key: ORDER_ADJUSTMENTS_SUMMARY_KEY,
            type: "single_line_text_field",
            // 空の文字は書けないので、行が無いときは「なし」
            value: summary || "なし",
          },
        ],
      },
    });
    const json = (await res.json()) as {
      errors?: { message: string }[];
      data?: { metafieldsSet?: { userErrors?: { message: string }[] } };
    };
    const errs = [
      ...(json.errors ?? []).map((e) => e.message),
      ...(json.data?.metafieldsSet?.userErrors ?? []).map((e) => e.message),
    ];
    if (errs.length > 0) throw new Error(errs.join("; "));
    await prisma.specialRefundEvent.updateMany({
      where: { shopId, sourceOrderId: { in: orderIdVariants } },
      data: { metafieldSyncedAt: new Date(), metafieldSyncError: null },
    });
    return { ok: true, doc, summary };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    console.warn(`[order-adjustments] metafield write failed shop=${shopId} order=${orderGid}: ${message}`);
    try {
      await prisma.specialRefundEvent.updateMany({
        where: { shopId, sourceOrderId: { in: orderIdVariants } },
        data: { metafieldSyncError: message },
      });
    } catch {
      // 記録に失敗しても登録は取り消さない
    }
    return { ok: false, error: message };
  }
}

/**
 * 注文のメタフィールドの値を読む（精算用）。読めた注文だけ Map に入る（値が無い注文は null）。
 * 呼び出しが失敗したら throw せず fetched=false を返す（精算は DB の行で数え、止めない）。
 */
export async function fetchOrderAdjustmentDocs(
  admin: AdminClient,
  orderIds: string[],
): Promise<{ fetched: boolean; docs: Map<string, string | null> }> {
  const docs = new Map<string, string | null>();
  const ids = [...new Set(orderIds.map(toOrderGid))];
  if (ids.length === 0) return { fetched: true, docs };
  try {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const json = await adminGraphqlWithRetry<{
        errors?: unknown[];
        data?: { nodes?: ({ id?: string; adjustments?: { value?: string | null } | null } | null)[] };
      }>(admin as AdminGraphqlClient, ORDER_ADJUSTMENTS_DOCS_QUERY, { variables: { ids: chunk } }, "orderAdjustmentsDocs");
      if (json.errors && json.errors.length > 0) throw new Error("graphql errors");
      for (const node of json.data?.nodes ?? []) {
        if (node?.id) docs.set(node.id, node.adjustments?.value ?? null);
      }
    }
    return { fetched: true, docs };
  } catch (err) {
    console.warn(
      `[order-adjustments] metafield read failed count=${ids.length}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { fetched: false, docs: new Map() };
  }
}

const ORDER_VOUCHER_TX_QUERY = `#graphql
  query OrderVoucherTransactions($id: ID!) {
    order(id: $id) {
      id
      name
      transactions(first: 100) {
        kind
        status
        gateway
        formattedGateway
        amountSet { shopMoney { amount } }
      }
    }
  }
`;

/**
 * 注文の取引から、商品券で払った額（使った額）を出す（④ 額面だけを入れる画面のため）。
 * 読めなければ null（POS では手で入れてもらう）。
 */
export async function fetchOrderVoucherApplied(
  admin: AdminClient,
  sourceOrderId: string,
): Promise<{ applied: number; orderName: string | null } | null> {
  try {
    const json = await adminGraphqlWithRetry<{
      errors?: unknown[];
      data?: {
        order?: {
          name?: string | null;
          transactions?: {
            kind?: string | null;
            status?: string | null;
            gateway?: string | null;
            formattedGateway?: string | null;
            amountSet?: { shopMoney?: { amount?: string | null } | null } | null;
          }[];
        } | null;
      };
    }>(admin as AdminGraphqlClient, ORDER_VOUCHER_TX_QUERY, { variables: { id: toOrderGid(sourceOrderId) } }, "orderVoucherTx");
    if ((json.errors && json.errors.length > 0) || !json.data?.order) return null;
    const txs = (json.data.order.transactions ?? []).map((t) => ({
      kind: t.kind,
      status: t.status,
      gateway: t.gateway,
      formattedGateway: t.formattedGateway,
      amount: Number(t.amountSet?.shopMoney?.amount ?? 0),
    }));
    return { applied: voucherAppliedFromTransactions(txs), orderName: json.data.order.name ?? null };
  } catch (err) {
    console.warn(`[order-adjustments] voucher tx read failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
