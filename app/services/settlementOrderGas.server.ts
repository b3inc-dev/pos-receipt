/**
 * 精算注文の Shopify 側処理（GAS docs/GAS_精算レシート.md 準拠）
 * - newSettlementFresh → createSettlementOrderAlways + upsertSettlement 相当
 * - uiCreateZeroInspection → createZeroInspectionOrder 相当
 * - fulfillAllForOrder（発送済み化）
 * - LOC:店名 / SETL- 一意タグ / 精算・点検用顧客
 */
import type { SettlementPreviewDTO } from "./settlementEngine.server";
import {
  getShopTimezoneForDaily,
  getDayRangeShopifySearchIso,
  getCalendarDateStringInTimeZone,
} from "../utils/shopTimezone.server";

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

export interface SettlementOrderSyncOptions {
  attachNote?: boolean;
  attachMetafields?: boolean;
  /** 新規作成直後のみ true（GAS createSettlementOrderAlways / uiCreateZeroInspection） */
  fulfillOnCreate?: boolean;
}

const ORDERS_SEARCH = `#graphql
  query OrdersSettlementSearch($q: String!, $first: Int!) {
    orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          note
          tags
          metafield(namespace: "settlement", key: "location_label") {
            value
          }
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

const DRAFT_ORDER_ORDER = `#graphql
  query GasDraftOrderOrder($id: ID!) {
    node(id: $id) {
      ... on DraftOrder {
        id
        order {
          id
          name
        }
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

const ORDER_UPDATE = `#graphql
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

const TAGS_ADD = `#graphql
  mutation GasTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors {
        field
        message
      }
    }
  }
`;

const CUSTOMERS_SEARCH = `#graphql
  query GasCustomersSearch($q: String!) {
    customers(first: 1, query: $q) {
      edges {
        node {
          id
        }
      }
    }
  }
`;

const CUSTOMER_CREATE = `#graphql
  mutation GasCustomerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FULFILLMENT_ORDERS_QUERY = `#graphql
  query GasFulfillmentOrders($id: ID!) {
    node(id: $id) {
      ... on Order {
        fulfillmentOrders(first: 20) {
          edges {
            node {
              id
              lineItems(first: 200) {
                edges {
                  node {
                    id
                    remainingQuantity
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_V2 = `#graphql
  mutation GasFulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
    fulfillmentCreateV2(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FULFILLMENT_CREATE = `#graphql
  mutation GasFulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
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

function escapeQuote(s: string): string {
  return String(s).replace(/"/g, '\\"');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GAS labelDate: yyyy/MM/dd */
function toGasLabelDate(targetDateYmd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetDateYmd.trim());
  if (!m) return targetDateYmd;
  return `${m[1]}/${m[2]}/${m[3]}`;
}

function buildSettlementUniqTag(targetDateYmd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetDateYmd.trim());
  const y = m?.[1] ?? "1970";
  const mo = m?.[2] ?? "01";
  const dd = m?.[3] ?? "02";
  const shortId = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `SETL-${y.slice(2)}${mo}${dd}-${shortId}`;
}

function buildInspectionUniqTag(): string {
  const now = new Date();
  const y = String(now.getFullYear());
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const shortId = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `INSP-${y.slice(2)}${mo}${dd}-${shortId}`;
}

function locTag(locationName: string): string {
  return `LOC:${String(locationName).trim()}`;
}

/** GAS formatNowJST 相当 */
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

function buildGasInspectionNote(
  periodLabel: string,
  locationName: string,
  asOf: string,
): string {
  return [
    "SETTLEMENT|1",
    `period:${periodLabel}`,
    `location:${locationName}`,
    `as_of:${asOf}`,
    "net:0",
    "total:0",
    "discounts:0",
    "vip:0",
    "tax:0",
    "orders:0",
    "refunds:0",
    "items:0",
  ].join("\n");
}

function buildSettlementSearchQuery(start: string, end: string): string {
  return `tag:SETTLEMENT created_at:>=${start} created_at:<=${end}`;
}

type OrderHit = {
  id: string;
  name: string;
  note?: string | null;
  tags?: string[];
  metafield?: { value?: string | null } | null;
};

async function searchOrders(
  admin: AdminClient,
  q: string,
  first = 15,
): Promise<OrderHit[]> {
  const res = await admin.graphql(ORDERS_SEARCH, { variables: { q, first } });
  const json = (await res.json()) as {
    errors?: { message: string }[];
    data?: { orders?: { edges?: { node: OrderHit }[] } };
  };
  if (json.errors?.length) {
    throw new Error(`精算注文の検索に失敗しました: ${json.errors.map((e) => e.message).join(", ")}`);
  }
  return (json.data?.orders?.edges ?? []).map((e) => e.node);
}

function orderMatchesLocation(node: OrderHit, locationName: string): boolean {
  const note = node.note ?? "";
  const paren = `(${locationName})`;
  const locLine = `location:${locationName}`;
  if (note.includes(paren) || note.includes(locLine)) return true;
  const tags = node.tags ?? [];
  if (tags.some((t) => t === locTag(locationName))) return true;
  const mf = node.metafield?.value?.trim();
  return mf === locationName;
}

/**
 * GAS uiUpsertLatestForLocation: LOC タグ → メタ location_label → ノート
 */
async function searchSettlementOrderGas(
  admin: AdminClient,
  start: string,
  end: string,
  locationName: string,
): Promise<{ id: string; name: string } | null> {
  const loc = locTag(locationName);
  const qLoc = `tag:SETTLEMENT AND tag:"${escapeQuote(loc)}"`;
  const byLoc = await searchOrders(admin, qLoc, 1);
  if (byLoc.length > 0 && orderMatchesLocation(byLoc[0], locationName)) {
    return { id: byLoc[0].id, name: byLoc[0].name };
  }

  const qSettle = buildSettlementSearchQuery(start, end);
  const edges = await searchOrders(admin, qSettle, 25);
  for (const n of edges) {
    if (orderMatchesLocation(n, locationName)) {
      return { id: n.id, name: n.name };
    }
  }

  const qBroad = "tag:SETTLEMENT";
  const broad = await searchOrders(admin, qBroad, 25);
  for (const n of broad) {
    if (orderMatchesLocation(n, locationName)) {
      return { id: n.id, name: n.name };
    }
  }

  return null;
}

async function searchOrderByUniqTag(
  admin: AdminClient,
  uniq: string,
): Promise<{ id: string; name: string } | null> {
  const q = `tag:"${escapeQuote(uniq)}"`;
  const nodes = await searchOrders(admin, q, 1);
  if (!nodes.length) return null;
  return { id: nodes[0].id, name: nodes[0].name };
}

async function ensureSettlementCustomer(admin: AdminClient, locationName: string): Promise<string> {
  const last = String(locationName).trim();
  const first = "精算 ";
  const q = `last_name:"${escapeQuote(last)}" AND first_name:"${escapeQuote(first)}"`;
  const foundRes = await admin.graphql(CUSTOMERS_SEARCH, { variables: { q } });
  const foundJson = (await foundRes.json()) as {
    data?: { customers?: { edges?: { node: { id: string } }[] } };
  };
  const existing = foundJson.data?.customers?.edges?.[0]?.node?.id;
  if (existing) return existing;

  const createRes = await admin.graphql(CUSTOMER_CREATE, {
    variables: {
      input: {
        firstName: first,
        lastName: last,
        tags: ["SETTLEMENT", "INTERNAL"],
      },
    },
  });
  const createJson = (await createRes.json()) as {
    data?: { customerCreate?: { customer?: { id: string }; userErrors: { message: string }[] } };
  };
  const custId = createJson.data?.customerCreate?.customer?.id;
  if (!custId) {
    const ue = createJson.data?.customerCreate?.userErrors ?? [];
    throw new Error(`精算用顧客の作成に失敗しました: ${ue.map((e) => e.message).join(", ")}`);
  }
  return custId;
}

async function ensureInspectionCustomer(admin: AdminClient, locationName: string): Promise<string> {
  const last = String(locationName).trim();
  const first = "点検 ";
  const q = `last_name:"${escapeQuote(last)}" AND first_name:"${escapeQuote(first)}"`;
  const foundRes = await admin.graphql(CUSTOMERS_SEARCH, { variables: { q } });
  const foundJson = (await foundRes.json()) as {
    data?: { customers?: { edges?: { node: { id: string } }[] } };
  };
  const existing = foundJson.data?.customers?.edges?.[0]?.node?.id;
  if (existing) return existing;

  const createRes = await admin.graphql(CUSTOMER_CREATE, {
    variables: {
      input: {
        firstName: first,
        lastName: last,
        tags: ["INSPECTION", "INTERNAL"],
      },
    },
  });
  const createJson = (await createRes.json()) as {
    data?: { customerCreate?: { customer?: { id: string }; userErrors: { message: string }[] } };
  };
  const custId = createJson.data?.customerCreate?.customer?.id;
  if (!custId) {
    const ue = createJson.data?.customerCreate?.userErrors ?? [];
    throw new Error(`点検用顧客の作成に失敗しました: ${ue.map((e) => e.message).join(", ")}`);
  }
  return custId;
}

async function resolveOrderFromDraftWithBackoff(
  admin: AdminClient,
  draftId: string,
): Promise<{ id: string; name: string } | null> {
  let wait = 300;
  for (let i = 0; i < 8; i++) {
    const res = await admin.graphql(DRAFT_ORDER_ORDER, { variables: { id: draftId } });
    const json = (await res.json()) as {
      data?: { node?: { order?: { id: string; name: string } | null } | null };
    };
    const order = json.data?.node?.order;
    if (order?.id) return { id: order.id, name: order.name };
    await sleep(wait);
    wait = Math.min(wait * 2, 2000);
  }
  return null;
}

async function completeDraftOrder(admin: AdminClient, draftId: string): Promise<void> {
  let completeRes = await admin.graphql(DRAFT_ORDER_COMPLETE, {
    variables: { id: draftId, paymentPending: true },
  });
  let completeJson = (await completeRes.json()) as {
    errors?: { message: string }[];
    data?: { draftOrderComplete?: { userErrors: { message: string }[] } };
  };

  const gqlErrMsg = completeJson.errors?.map((e) => e.message).join(", ") ?? "";
  if (completeJson.errors?.length && /paymentPending|Unknown argument/i.test(gqlErrMsg)) {
    completeRes = await admin.graphql(DRAFT_ORDER_COMPLETE_SIMPLE, { variables: { id: draftId } });
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
 * GAS createSettlementOrderAlways
 */
async function createSettlementOrderAlwaysGas(
  admin: AdminClient,
  targetDateYmd: string,
  locationName: string,
): Promise<{ orderId: string; orderName: string; uniqTag: string; created: boolean }> {
  const labelDate = toGasLabelDate(targetDateYmd);
  const uniq = buildSettlementUniqTag(targetDateYmd);
  const customerId = await ensureSettlementCustomer(admin, locationName);
  const draftNote = `Daily Settlement ${labelDate} [${uniq}]`;

  const createRes = await admin.graphql(DRAFT_ORDER_CREATE, {
    variables: {
      input: {
        note: draftNote,
        tags: ["SETTLEMENT", locTag(locationName), uniq],
        customerId,
        lineItems: [
          {
            title: "Daily Settlement (internal)",
            quantity: 1,
            originalUnitPrice: "0.00",
            requiresShipping: true,
          },
        ],
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
  const draftId = createJson.data?.draftOrderCreate?.draftOrder?.id;
  if (!draftId) {
    const ue = createJson.data?.draftOrderCreate?.userErrors ?? [];
    throw new Error(`精算下書き注文の作成に失敗しました: ${ue.map((e) => e.message).join(", ")}`);
  }

  await completeDraftOrder(admin, draftId);

  let order = await resolveOrderFromDraftWithBackoff(admin, draftId);
  if (!order) {
    order = await searchOrderByUniqTag(admin, uniq);
  }
  if (!order) {
    await sleep(1500);
    order = await searchOrderByUniqTag(admin, uniq);
  }
  if (!order) {
    throw new Error("精算注文の確定後に注文を検索できませんでした（GAS uniq フォールバック後）");
  }

  try {
    await metafieldsSetGas(admin, order.id, [
      {
        ownerId: order.id,
        namespace: "settlement",
        key: "uniq",
        type: "single_line_text_field",
        value: uniq,
      },
      {
        ownerId: order.id,
        namespace: "settlement",
        key: "location_label",
        type: "single_line_text_field",
        value: locationName,
      },
    ]);
  } catch {
    /* GAS: メタ失敗は致命ではない */
  }

  return { orderId: order.id, orderName: order.name, uniqTag: uniq, created: true };
}

/**
 * GAS createZeroInspectionOrder
 */
async function createZeroInspectionOrderGas(
  admin: AdminClient,
  locationName: string,
): Promise<{ orderId: string; orderName: string; uniqTag: string }> {
  const iana = "Asia/Tokyo";
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: iana,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const dd = parts.find((p) => p.type === "day")?.value ?? "01";
  const uniq = buildInspectionUniqTag();
  const customerId = await ensureInspectionCustomer(admin, locationName);
  const draftNote = `Daily Inspection ${y}/${m}/${dd} [${uniq}]`;

  const createRes = await admin.graphql(DRAFT_ORDER_CREATE, {
    variables: {
      input: {
        note: draftNote,
        tags: ["SETTLEMENT", "INSPECTION", locTag(locationName), uniq],
        customerId,
        lineItems: [
          {
            title: "Inspection (internal)",
            quantity: 1,
            originalUnitPrice: "0.00",
            requiresShipping: false,
          },
        ],
        useCustomerDefaultAddress: false,
      },
    },
  });
  const createJson = (await createRes.json()) as {
    data?: {
      draftOrderCreate?: {
        draftOrder?: { id: string };
        userErrors: { message: string }[];
      };
    };
  };
  const draftId = createJson.data?.draftOrderCreate?.draftOrder?.id;
  if (!draftId) {
    const ue = createJson.data?.draftOrderCreate?.userErrors ?? [];
    throw new Error(`点検下書き注文の作成に失敗しました: ${ue.map((e) => e.message).join(", ")}`);
  }

  await completeDraftOrder(admin, draftId);

  let order = await searchOrderByUniqTag(admin, uniq);
  if (!order) {
    await sleep(1200);
    order = await searchOrderByUniqTag(admin, uniq);
  }
  if (!order) {
    await sleep(1500);
    order = await searchOrderByUniqTag(admin, uniq);
  }
  if (!order) {
    throw new Error("点検注文の確定後に注文を検索できませんでした");
  }

  return { orderId: order.id, orderName: order.name, uniqTag: uniq };
}

/** GAS fulfillAllForOrder */
export async function fulfillAllForOrderGas(admin: AdminClient, orderId: string): Promise<void> {
  const res = await admin.graphql(FULFILLMENT_ORDERS_QUERY, { variables: { id: orderId } });
  const json = (await res.json()) as {
    data?: {
      node?: {
        fulfillmentOrders?: {
          edges?: {
            node: {
              id: string;
              lineItems?: {
                edges?: { node: { id: string; remainingQuantity: number } }[];
              };
            };
          }[];
        };
      };
    };
  };

  const fos = json.data?.node?.fulfillmentOrders?.edges ?? [];
  if (!fos.length) return;

  for (const edge of fos) {
    const fo = edge.node;
    const items = (fo.lineItems?.edges ?? [])
      .map((e) => ({ id: e.node.id, qty: Number(e.node.remainingQuantity || 0) }))
      .filter((x) => x.qty > 0);
    if (!items.length) continue;

    const fulfillment = {
      notifyCustomer: false,
      lineItemsByFulfillmentOrder: [
        {
          fulfillmentOrderId: fo.id,
          fulfillmentOrderLineItems: items.map((x) => ({ id: x.id, quantity: x.qty })),
        },
      ],
    };

    let fRes = await admin.graphql(FULFILLMENT_CREATE_V2, { variables: { fulfillment } });
    let fJson = (await fRes.json()) as {
      errors?: { message: string }[];
      data?: { fulfillmentCreateV2?: { userErrors: { message: string }[] } };
    };

    const errMsg = fJson.errors?.map((e) => e.message).join(", ") ?? "";
    if (fJson.errors?.length && /fulfillmentCreateV2|Field.*not found/i.test(errMsg)) {
      fRes = await admin.graphql(FULFILLMENT_CREATE, { variables: { fulfillment } });
      fJson = (await fRes.json()) as {
        errors?: { message: string }[];
        data?: { fulfillmentCreate?: { userErrors: { message: string }[] } };
      };
      const ue = fJson.data?.fulfillmentCreate?.userErrors ?? [];
      if (ue.length) {
        throw new Error(`fulfillmentCreate error: ${ue.map((e) => e.message).join(", ")}`);
      }
      if (fJson.errors?.length) {
        throw new Error(`fulfillmentCreate error: ${errMsg}`);
      }
      continue;
    }

    const ue = fJson.data?.fulfillmentCreateV2?.userErrors ?? [];
    if (ue.length) {
      throw new Error(`fulfillmentCreateV2 error: ${ue.map((e) => e.message).join(", ")}`);
    }
    if (fJson.errors?.length) {
      throw new Error(`fulfillmentCreateV2 error: ${errMsg}`);
    }
  }
}

async function tagsAddGas(admin: AdminClient, orderId: string, tags: string[]): Promise<void> {
  if (!tags.length) return;
  const res = await admin.graphql(TAGS_ADD, { variables: { id: orderId, tags } });
  const json = (await res.json()) as {
    data?: { tagsAdd?: { userErrors: { message: string }[] } };
  };
  const ue = json.data?.tagsAdd?.userErrors ?? [];
  if (ue.length) {
    throw new Error(`注文タグの追加に失敗しました: ${ue.map((e) => e.message).join(", ")}`);
  }
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
  metafields: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }>,
): Promise<void> {
  if (!metafields.length) return;
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
  const res = await admin.graphql(ORDER_UPDATE, {
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

function buildSettlementMetafields(
  orderId: string,
  preview: SettlementPreviewDTO,
  periodLabel: string,
  asOf: string,
  version: number,
  paymentSectionRows: string[],
): Array<{
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}> {
  return [
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
}

function buildInspectionMetafields(
  orderId: string,
  locationName: string,
  periodLabel: string,
  asOf: string,
): Array<{
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}> {
  return [
    { ownerId: orderId, namespace: "settlement", key: "period_label", type: "single_line_text_field", value: periodLabel },
    { ownerId: orderId, namespace: "settlement", key: "location_label", type: "single_line_text_field", value: locationName },
    { ownerId: orderId, namespace: "settlement", key: "as_of", type: "single_line_text_field", value: asOf },
    { ownerId: orderId, namespace: "settlement", key: "copy_type", type: "single_line_text_field", value: "inspection" },
    { ownerId: orderId, namespace: "settlement", key: "total", type: "number_decimal", value: "0" },
    { ownerId: orderId, namespace: "settlement", key: "refund_total", type: "number_decimal", value: "0" },
    { ownerId: orderId, namespace: "settlement", key: "discounts", type: "number_decimal", value: "0" },
    { ownerId: orderId, namespace: "settlement", key: "vip_points_used", type: "number_decimal", value: "0" },
    { ownerId: orderId, namespace: "settlement", key: "tax", type: "number_decimal", value: "0" },
    { ownerId: orderId, namespace: "settlement", key: "net_sales", type: "number_decimal", value: "0" },
    { ownerId: orderId, namespace: "settlement", key: "order_count", type: "number_integer", value: "0" },
    { ownerId: orderId, namespace: "settlement", key: "refund_count", type: "number_integer", value: "0" },
    { ownerId: orderId, namespace: "settlement", key: "item_count", type: "number_integer", value: "0" },
    {
      ownerId: orderId,
      namespace: "settlement",
      key: "payment_sections",
      type: "list.single_line_text_field",
      value: JSON.stringify([]),
    },
  ];
}

/**
 * GAS newSettlementFresh / upsertSettlement 相当（通常精算）
 */
export async function syncSettlementOrderLikeGas(
  admin: AdminClient,
  shopId: string,
  preview: SettlementPreviewDTO,
  syncOpts: SettlementOrderSyncOptions = {},
): Promise<{ orderId: string; orderName: string }> {
  const attachNote = syncOpts.attachNote !== false;
  const attachMetafields = syncOpts.attachMetafields !== false;

  const iana = await getShopTimezoneForDaily(admin, shopId);
  const { start, end } = getDayRangeShopifySearchIso(preview.targetDate, iana);
  const labelDate = toGasLabelDate(preview.targetDate);

  let order = await searchSettlementOrderGas(admin, start, end, preview.locationName);
  let created = false;

  if (!order) {
    const createdOrder = await createSettlementOrderAlwaysGas(
      admin,
      preview.targetDate,
      preview.locationName,
    );
    order = { id: createdOrder.orderId, name: createdOrder.orderName };
    created = true;
  } else {
    try {
      await tagsAddGas(admin, order.id, [locTag(preview.locationName)]);
    } catch {
      /* 既存タグの重複は無視 */
    }
  }

  // GAS createSettlementOrderAlways / uiCreateZeroInspection: 新規作成時のみ履行
  if (created || syncOpts.fulfillOnCreate === true) {
    try {
      await fulfillAllForOrderGas(admin, order.id);
    } catch {
      /* GAS: なくても OK（FO 無し等） */
    }
  }

  const prevVersion = attachMetafields ? await readSettlementVersion(admin, order.id) : 0;
  const version = attachMetafields ? prevVersion + 1 : prevVersion;

  const ft = preview.settlementTxFirstHm ?? "00:00";
  const lt = preview.settlementTxLastHm ?? "23:59";
  const periodLabel = `${labelDate} ${ft}–${lt}`;
  const asOf = formatNowYmdHm(iana);
  const paymentSectionRows = buildGasPaymentSectionRows(preview);

  if (attachMetafields) {
    await metafieldsSetGas(admin, buildSettlementMetafields(order.id, preview, periodLabel, asOf, version, paymentSectionRows));
  }

  if (attachNote) {
    const noteText = buildGasSettlementNote(periodLabel, preview.locationName, asOf, preview, paymentSectionRows);
    await orderUpdateNoteGas(admin, order.id, noteText);
  }

  return { orderId: order.id, orderName: order.name };
}

/**
 * GAS uiCreateZeroInspection 相当（点検レシート）
 */
export async function syncInspectionOrderLikeGas(
  admin: AdminClient,
  shopId: string,
  locationName: string,
  syncOpts: SettlementOrderSyncOptions = {},
): Promise<{ orderId: string; orderName: string }> {
  const attachNote = syncOpts.attachNote !== false;
  const attachMetafields = syncOpts.attachMetafields !== false;

  const created = await createZeroInspectionOrderGas(admin, locationName);

  if (syncOpts.fulfillOnCreate !== false) {
    try {
      await fulfillAllForOrderGas(admin, created.orderId);
    } catch {
      /* GAS */
    }
  }

  const iana = await getShopTimezoneForDaily(admin, shopId);
  const asOf = formatNowYmdHm(iana);
  const labelDate = toGasLabelDate(getCalendarDateStringInTimeZone(new Date(), iana));
  const hm = asOf.split(" ")[1] ?? "00:00";
  const periodLabel = `${labelDate} ${hm}–${hm}`;

  if (attachMetafields) {
    await metafieldsSetGas(admin, buildInspectionMetafields(created.orderId, locationName, periodLabel, asOf));
  }

  if (attachNote) {
    await orderUpdateNoteGas(admin, created.orderId, buildGasInspectionNote(periodLabel, locationName, asOf));
  }

  return { orderId: created.orderId, orderName: created.orderName };
}
