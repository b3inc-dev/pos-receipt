/**
 * 精算注文の Shopify 側処理を GAS（docs/GAS_精算レシート.md）に揃える。
 * - findOrCreate: 当日・tag:SETTLEMENT の既存注文を再利用、なければ Draft→Complete（paymentPending: true）→検索リトライ
 * - upsert: settlement メタフィールド一式 + orderUpdate で GAS 形式の note
 */
import type { SettlementPreviewDTO } from "./settlementEngine.server";
import { getShopTimezoneForDaily, getDayRangeShopifySearchIso } from "../utils/shopTimezone.server";

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

const ORDERS_SEARCH = `#graphql
  query OrdersSettlementSearch($q: String!) {
    orders(first: 15, query: $q, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          note
        }
      }
    }
  }
`;

const ORDER_VERSION_MF = `#graphql
  query OrderSettlementVersion($id: ID!) {
    node(id: $id) {
      ... on Order {
        metafield(namespace: "settlement", key: "version") {
          value
        }
      }
    }
  }
`;

const DRAFT_ORDER_CREATE = `#graphql
  mutation GasDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DRAFT_ORDER_COMPLETE = `#graphql
  mutation GasDraftOrderComplete($id: ID!, $paymentPending: Boolean) {
    draftOrderComplete(id: $id, paymentPending: $paymentPending) {
      draftOrder {
        id
        order {
          id
          name
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/** GAS は paymentPending:true だが、API で廃止されているストア向けフォールバック */
const DRAFT_ORDER_COMPLETE_SIMPLE = `#graphql
  mutation GasDraftOrderCompleteSimple($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder {
        id
        order {
          id
          name
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const METAFIELDS_SET = `#graphql
  mutation GasMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_UPDATE_NOTE = `#graphql
  mutation GasOrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function roundYen(n: number): number {
  return Math.round(Number(n) || 0);
}

/** GAS labelDate: yyyy/MM/dd */
function toGasLabelDate(targetDateYmd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetDateYmd.trim());
  if (!m) return targetDateYmd;
  return `${m[1]}/${m[2]}/${m[3]}`;
}

/** GAS formatNowJST 相当（ショップの日次タイムゾーンで yyyy-MM-dd HH:mm） */
function formatNowYmdHm(ianaTimezone: string): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: ianaTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const mo = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  let hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  let minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  if (hour.length === 1) hour = `0${hour}`;
  if (minute.length === 1) minute = `0${minute}`;
  return `${y}-${mo}-${d} ${hour}:${minute}`;
}

/**
 * GAS stringifyPaymentSections / makePaymentSections と同じ列形式（日本語ヘッダー）
 */
function buildGasPaymentSectionRows(preview: SettlementPreviewDTO): string[] {
  return preview.paymentSections.map((s) => {
    const net = roundYen(s.net);
    const refund = roundYen(s.refund);
    const tx = Math.max(0, roundYen(s.txCount) - roundYen(s.refundCount));
    const rc = Math.max(0, roundYen(s.refundCount));
    const label = s.label || s.gateway || "未分類";
    return `${label}|売上額|${net}|返金額|${refund}|売上件数|${tx}|返金件数|${rc}`;
  });
}

/** GAS buildSettlementNote 相当 */
function buildGasSettlementNote(
  periodLabel: string,
  locationName: string,
  asOf: string,
  preview: SettlementPreviewDTO,
  paymentSectionRows: string[],
): string {
  const lines: string[] = [];
  lines.push("SETTLEMENT|1");
  lines.push(`period:${periodLabel}`);
  lines.push(`location:${locationName}`);
  lines.push(`as_of:${asOf}`);
  lines.push(`net:${preview.netSales}`);
  lines.push(`total:${preview.total}`);
  lines.push(`discounts:${preview.discounts}`);
  lines.push(`vip:${preview.vipPointsUsed}`);
  lines.push(`tax:${preview.tax}`);
  lines.push(`orders:${preview.orderCount}`);
  lines.push(`refunds:${preview.refundCount}`);
  lines.push(`items:${preview.itemCount}`);
  const vchg = roundYen(preview.voucherChangeAmount);
  if (vchg > 0) {
    lines.push(`voucher_change:${vchg}`);
  }
  for (const row of paymentSectionRows) {
    lines.push(`p:${row}`);
  }
  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSettlementSearchQuery(start: string, end: string): string {
  return `tag:SETTLEMENT created_at:>=${start} created_at:<=${end}`;
}

/**
 * GAS は query が tag+日付のみだが、同一ショップ複数ロケーションでは取り違え防止のため、
 * 下書き時ノート `Daily Settlement … (${locationName})` と一致する注文だけ再利用する。
 */
async function searchSettlementOrder(
  admin: AdminClient,
  start: string,
  end: string,
  locationName: string,
): Promise<{ id: string; name: string } | null> {
  const q = buildSettlementSearchQuery(start, end);
  const res = await admin.graphql(ORDERS_SEARCH, { variables: { q } });
  const json = (await res.json()) as {
    errors?: { message: string }[];
    data?: { orders?: { edges?: { node: { id: string; name: string; note?: string | null } }[] } };
  };
  if (json.errors?.length) {
    throw new Error(`精算注文の検索に失敗しました: ${json.errors.map((e) => e.message).join(", ")}`);
  }
  const edges = json.data?.orders?.edges ?? [];
  const paren = `(${locationName})`;
  const locLine = `location:${locationName}`;
  for (const e of edges) {
    const n = e.node;
    const note = n.note ?? "";
    // 下書き直後: "Daily Settlement … (店名)" / upsert 後: buildSettlementNote の location: 行
    if (note.includes(paren) || note.includes(locLine)) {
      return { id: n.id, name: n.name };
    }
  }
  return null;
}

async function readSettlementVersion(admin: AdminClient, orderId: string): Promise<number> {
  const res = await admin.graphql(ORDER_VERSION_MF, { variables: { id: orderId } });
  const json = (await res.json()) as {
    data?: { node?: { metafield?: { value?: string | null } | null } | null };
  };
  const raw = json.data?.node?.metafield?.value;
  const n = raw != null && raw !== "" ? Number.parseInt(String(raw), 10) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function metafieldsSetGas(
  admin: AdminClient,
  orderId: string,
  preview: SettlementPreviewDTO,
  periodLabel: string,
  asOf: string,
  version: number,
  paymentSectionRows: string[],
): Promise<void> {
  const metafields: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }> = [
    { ownerId: orderId, namespace: "settlement", key: "period_label", type: "single_line_text_field", value: periodLabel },
    { ownerId: orderId, namespace: "settlement", key: "location_label", type: "single_line_text_field", value: preview.locationName },
    { ownerId: orderId, namespace: "settlement", key: "as_of", type: "single_line_text_field", value: asOf },
    { ownerId: orderId, namespace: "settlement", key: "version", type: "number_integer", value: String(version) },
    { ownerId: orderId, namespace: "settlement", key: "total", type: "number_decimal", value: String(roundYen(preview.total)) },
    { ownerId: orderId, namespace: "settlement", key: "refund_total", type: "number_decimal", value: String(roundYen(preview.refundTotal)) },
    { ownerId: orderId, namespace: "settlement", key: "discounts", type: "number_decimal", value: String(roundYen(preview.discounts)) },
    { ownerId: orderId, namespace: "settlement", key: "vip_points_used", type: "number_decimal", value: String(roundYen(preview.vipPointsUsed)) },
    { ownerId: orderId, namespace: "settlement", key: "tax", type: "number_decimal", value: String(roundYen(preview.tax)) },
    { ownerId: orderId, namespace: "settlement", key: "net_sales", type: "number_decimal", value: String(roundYen(preview.netSales)) },
    {
      ownerId: orderId,
      namespace: "settlement",
      key: "tax_shopify",
      type: "number_decimal",
      value: String(roundYen(preview.taxShopify)),
    },
    { ownerId: orderId, namespace: "settlement", key: "voucher_change", type: "number_integer", value: String(roundYen(preview.voucherChangeAmount)) },
    { ownerId: orderId, namespace: "settlement", key: "order_count", type: "number_integer", value: String(roundYen(preview.orderCount)) },
    { ownerId: orderId, namespace: "settlement", key: "refund_count", type: "number_integer", value: String(roundYen(preview.refundCount)) },
    { ownerId: orderId, namespace: "settlement", key: "item_count", type: "number_integer", value: String(roundYen(preview.itemCount)) },
    {
      ownerId: orderId,
      namespace: "settlement",
      key: "payment_sections",
      type: "list.single_line_text_field",
      value: JSON.stringify(paymentSectionRows),
    },
  ];

  const res = await admin.graphql(METAFIELDS_SET, { variables: { metafields } });
  const json = (await res.json()) as {
    errors?: { message: string }[];
    data?: { metafieldsSet?: { userErrors: { message: string }[] } };
  };
  if (json.errors?.length) {
    throw new Error(`精算メタフィールドの保存に失敗しました: ${json.errors.map((e) => e.message).join(", ")}`);
  }
  const uerr = json.data?.metafieldsSet?.userErrors ?? [];
  if (uerr.length > 0) {
    throw new Error(`精算メタフィールドの保存に失敗しました: ${uerr.map((e) => e.message).join(", ")}`);
  }
}

async function orderUpdateNoteGas(admin: AdminClient, orderId: string, note: string): Promise<void> {
  const res = await admin.graphql(ORDER_UPDATE_NOTE, {
    variables: { input: { id: orderId, note } },
  });
  const json = (await res.json()) as {
    errors?: { message: string }[];
    data?: { orderUpdate?: { userErrors: { message: string }[] } };
  };
  if (json.errors?.length) {
    throw new Error(`精算注文ノートの更新に失敗しました: ${json.errors.map((e) => e.message).join(", ")}`);
  }
  const uerr = json.data?.orderUpdate?.userErrors ?? [];
  if (uerr.length > 0) {
    throw new Error(`精算注文ノートの更新に失敗しました: ${uerr.map((e) => e.message).join(", ")}`);
  }
}

async function createDraftAndCompleteGas(
  admin: AdminClient,
  labelDate: string,
  locationName: string,
): Promise<void> {
  const draftNote = `Daily Settlement ${labelDate} (${locationName})`;
  const createRes = await admin.graphql(DRAFT_ORDER_CREATE, {
    variables: {
      input: {
        note: draftNote,
        tags: ["SETTLEMENT"],
        lineItems: [{ title: "Daily Settlement (internal)", quantity: 1, originalUnitPrice: "0.00" }],
        useCustomerDefaultAddress: false,
      },
    },
  });
  const createJson = (await createRes.json()) as {
    errors?: { message: string }[];
    data?: {
      draftOrderCreate?: {
        draftOrder?: { id: string };
        userErrors: { message: string }[];
      };
    };
  };
  if (createJson.errors?.length) {
    throw new Error(`精算下書き注文の作成に失敗しました: ${createJson.errors.map((e) => e.message).join(", ")}`);
  }
  const draft = createJson.data?.draftOrderCreate?.draftOrder;
  if (!draft?.id) {
    const ue = createJson.data?.draftOrderCreate?.userErrors ?? [];
    throw new Error(`精算下書き注文の作成に失敗しました: ${ue.map((e) => e.message).join(", ")}`);
  }

  let completeRes = await admin.graphql(DRAFT_ORDER_COMPLETE, {
    variables: { id: draft.id, paymentPending: true },
  });
  let completeJson = (await completeRes.json()) as {
    errors?: { message: string }[];
    data?: {
      draftOrderComplete?: {
        draftOrder?: { order?: { id: string; name: string } };
        userErrors: { message: string }[];
      };
    };
  };

  const gqlErrMsg = completeJson.errors?.map((e) => e.message).join(", ") ?? "";
  if (completeJson.errors?.length && /paymentPending|Unknown argument/i.test(gqlErrMsg)) {
    completeRes = await admin.graphql(DRAFT_ORDER_COMPLETE_SIMPLE, { variables: { id: draft.id } });
    completeJson = (await completeRes.json()) as typeof completeJson;
  }

  if (completeJson.errors?.length) {
    throw new Error(`精算注文の確定に失敗しました: ${completeJson.errors.map((e) => e.message).join(", ")}`);
  }
  const ue = completeJson.data?.draftOrderComplete?.userErrors ?? [];
  if (ue.length > 0) {
    throw new Error(`精算注文の確定に失敗しました: ${ue.map((e) => e.message).join(", ")}`);
  }
}

/**
 * GAS findOrCreateSettlement のあと upsert のメタ＋ノートまで実行し、注文 id/name を返す。
 */
export async function syncSettlementOrderLikeGas(
  admin: AdminClient,
  shopId: string,
  preview: SettlementPreviewDTO,
): Promise<{ orderId: string; orderName: string }> {
  const iana = await getShopTimezoneForDaily(admin, shopId);
  const { start, end } = getDayRangeShopifySearchIso(preview.targetDate, iana);
  const labelDate = toGasLabelDate(preview.targetDate);

  let order = await searchSettlementOrder(admin, start, end, preview.locationName);

  if (!order) {
    await createDraftAndCompleteGas(admin, labelDate, preview.locationName);
    await sleep(1500);
    order = await searchSettlementOrder(admin, start, end, preview.locationName);
    if (!order) {
      await sleep(1500);
      order = await searchSettlementOrder(admin, start, end, preview.locationName);
    }
    if (!order) {
      throw new Error("精算注文の確定後に注文を検索できませんでした（GAS 同様のリトライ後）");
    }
  }

  const prevVersion = await readSettlementVersion(admin, order.id);
  const version = prevVersion + 1;

  const ft = preview.settlementTxFirstHm ?? "00:00";
  const lt = preview.settlementTxLastHm ?? "23:59";
  const periodLabel = `${labelDate} ${ft}–${lt}`;
  const asOf = formatNowYmdHm(iana);
  const paymentSectionRows = buildGasPaymentSectionRows(preview);

  await metafieldsSetGas(admin, order.id, preview, periodLabel, asOf, version, paymentSectionRows);

  const noteText = buildGasSettlementNote(periodLabel, preview.locationName, asOf, preview, paymentSectionRows);
  await orderUpdateNoteGas(admin, order.id, noteText);

  return { orderId: order.id, orderName: order.name };
}
