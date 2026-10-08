/**
 * GDPR customers/data_request — アプリ DB に保存している顧客関連データの列挙方針。
 *
 * Shopify の必須応答は webhook 200（受理）。開示本体はストアオーナー経由で
 * 30 日以内に提供する運用（本モジュールは DB 列挙と根拠の明確化まで）。
 * 新規の個人情報カラム／永続エクスポート表は作らない。
 *
 * https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 */

export type CustomerDataRequestPayload = {
  shop_domain?: string;
  customer?: { id?: number | string; email?: string; phone?: string };
  orders_requested?: Array<number | string>;
  data_request?: { id?: number | string };
};

/** アプリが顧客連絡先（email/phone）を永続保存していない根拠 */
export const CUSTOMER_CONTACT_NOT_STORED_RATIONALE = [
  "customer.email / customer.phone をアプリ DB に保存するカラム・テーブルはない",
  "顧客マスタ同期は行わない（公開スコープに read_customers なし。自社会員証は別経路）",
  "注文検索・領収書表示で Shopify Admin API から都度取得するのみで、アプリ側に顧客連絡先を複製しない",
] as const;

/** 注文 ID に紐づきうる保存データ（開示対象になりうる） */
export const ORDER_LINKED_STORED_FIELDS = [
  "ReceiptIssue: orderId, orderName, recipientName（店員入力の宛名）, amount, currency, proviso, locationId, createdAt",
  "SpecialRefundEvent: sourceOrderId, sourceOrderName, eventType, amount, payment method labels, note（任意）",
] as const;

export function expandOrderIdVariants(
  ids: Array<number | string> | undefined | null
): string[] {
  const out = new Set<string>();
  for (const id of ids ?? []) {
    const s = String(id).trim();
    if (!s) continue;
    out.add(s);
    const digits = s.replace(/\D/g, "");
    if (digits) {
      out.add(digits);
      out.add(`gid://shopify/Order/${digits}`);
    }
  }
  return [...out];
}

export type ReceiptIssueInventoryRow = {
  orderId: string;
  orderName: string | null;
  hasRecipientName: boolean;
  recipientName: string | null;
  amount: string;
  currency: string | null;
  proviso: string | null;
  locationId: string;
  createdAt: string;
  isReissue: boolean;
};

export type SpecialRefundInventoryRow = {
  sourceOrderId: string;
  sourceOrderName: string | null;
  eventType: string;
  amount: string;
  currency: string | null;
  originalPaymentMethod: string | null;
  actualRefundMethod: string | null;
  note: string | null;
  status: string;
  createdAt: string;
};

export type CustomerDataInventory = {
  shopDomain: string;
  dataRequestId: string | null;
  customerShopifyId: string | null;
  /** webhook に email/phone が含まれていたか（アプリ保存の有無ではない） */
  webhookHadCustomerEmail: boolean;
  webhookHadCustomerPhone: boolean;
  ordersRequested: string[];
  orderIdVariantsQueried: string[];
  storesCustomerEmailOrPhone: false;
  receiptIssues: ReceiptIssueInventoryRow[];
  specialRefundEvents: SpecialRefundInventoryRow[];
  rationale: {
    notStored: readonly string[];
    storedLinkedToOrders: readonly string[];
  };
};

export type ReceiptIssueSource = {
  orderId: string;
  orderName: string | null;
  recipientName: string | null;
  amount: { toString(): string } | string | number;
  currency: string | null;
  proviso: string | null;
  locationId: string;
  createdAt: Date | string;
  isReissue: boolean;
};

export type SpecialRefundSource = {
  sourceOrderId: string;
  sourceOrderName: string | null;
  eventType: string;
  amount: { toString(): string } | string | number;
  currency: string | null;
  originalPaymentMethod: string | null;
  actualRefundMethod: string | null;
  note: string | null;
  status: string;
  createdAt: Date | string;
};

function amountToString(v: { toString(): string } | string | number): string {
  return typeof v === "string" || typeof v === "number" ? String(v) : v.toString();
}

function dateToIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/** DB 行から開示用インベントリを組み立てる（永続化しない） */
export function buildCustomerDataInventory(args: {
  shopDomain: string;
  payload: CustomerDataRequestPayload;
  receiptIssues: ReceiptIssueSource[];
  specialRefundEvents: SpecialRefundSource[];
}): CustomerDataInventory {
  const { shopDomain, payload, receiptIssues, specialRefundEvents } = args;
  const ordersRequested = (payload.orders_requested ?? []).map(String);
  const orderIdVariantsQueried = expandOrderIdVariants(payload.orders_requested);

  return {
    shopDomain,
    dataRequestId:
      payload.data_request?.id != null ? String(payload.data_request.id) : null,
    customerShopifyId:
      payload.customer?.id != null ? String(payload.customer.id) : null,
    webhookHadCustomerEmail: Boolean(payload.customer?.email),
    webhookHadCustomerPhone: Boolean(payload.customer?.phone),
    ordersRequested,
    orderIdVariantsQueried,
    storesCustomerEmailOrPhone: false,
    receiptIssues: receiptIssues.map((r) => {
      const name = (r.recipientName ?? "").trim();
      return {
        orderId: r.orderId,
        orderName: r.orderName,
        hasRecipientName: name.length > 0,
        recipientName: name.length > 0 ? name : null,
        amount: amountToString(r.amount),
        currency: r.currency,
        proviso: r.proviso,
        locationId: r.locationId,
        createdAt: dateToIso(r.createdAt),
        isReissue: r.isReissue,
      };
    }),
    specialRefundEvents: specialRefundEvents.map((e) => ({
      sourceOrderId: e.sourceOrderId,
      sourceOrderName: e.sourceOrderName,
      eventType: e.eventType,
      amount: amountToString(e.amount),
      currency: e.currency,
      originalPaymentMethod: e.originalPaymentMethod,
      actualRefundMethod: e.actualRefundMethod,
      note: e.note,
      status: e.status,
      createdAt: dateToIso(e.createdAt),
    })),
    rationale: {
      notStored: CUSTOMER_CONTACT_NOT_STORED_RATIONALE,
      storedLinkedToOrders: ORDER_LINKED_STORED_FIELDS,
    },
  };
}

/**
 * ログ用サマリ。宛名・note 等の本文は出さず、件数と ID のみ（ログへの PII 拡散を避ける）。
 */
export function summarizeInventoryForLog(inventory: CustomerDataInventory): Record<string, unknown> {
  return {
    shopDomain: inventory.shopDomain,
    dataRequestId: inventory.dataRequestId,
    customerShopifyId: inventory.customerShopifyId,
    webhookHadCustomerEmail: inventory.webhookHadCustomerEmail,
    webhookHadCustomerPhone: inventory.webhookHadCustomerPhone,
    storesCustomerEmailOrPhone: inventory.storesCustomerEmailOrPhone,
    ordersRequestedCount: inventory.ordersRequested.length,
    ordersRequested: inventory.ordersRequested,
    receiptIssueCount: inventory.receiptIssues.length,
    receiptIssuesWithRecipientName: inventory.receiptIssues.filter((r) => r.hasRecipientName)
      .length,
    specialRefundEventCount: inventory.specialRefundEvents.length,
    rationaleNotStored: inventory.rationale.notStored,
    rationaleStoredLinkedToOrders: inventory.rationale.storedLinkedToOrders,
  };
}
