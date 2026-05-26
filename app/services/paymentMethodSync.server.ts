/**
 * 直近取引の gateway を支払方法マスタへ自動登録（90日）
 */
import prisma from "../db.server";
import { transactionDisplayName } from "./orderDetail.server";

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

const GATEWAYS_FROM_ORDERS_QUERY = `#graphql
  query PaymentMethodSyncOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        transactions(first: 30) {
          gateway
          formattedGateway
          kind
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export interface PaymentMethodSyncResult {
  scannedOrderPages: number;
  gatewaysFound: number;
  created: number;
  skipped: number;
}

function normalizeGatewayKey(gateway: string): string {
  return gateway.trim();
}

async function fetchGatewayKeysFromOrders(
  admin: AdminClient,
  query: string,
  maxPages = 40,
): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;

  while (pages < maxPages) {
    const response = await admin.graphql(GATEWAYS_FROM_ORDERS_QUERY, {
      variables: { first: 100, after: cursor, query },
    });
    const json = (await response.json()) as {
      data?: {
        orders?: {
          nodes?: Array<{
            transactions?: Array<{
              gateway?: string | null;
              formattedGateway?: string | null;
              kind?: string | null;
            }>;
          }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      };
      errors?: unknown[];
    };
    if (json.errors?.length) break;

    const nodes = json.data?.orders?.nodes ?? [];
    for (const o of nodes) {
      for (const tx of o.transactions ?? []) {
        const kind = String(tx.kind ?? "").toUpperCase();
        if (kind && kind !== "SALE" && kind !== "CAPTURE") continue;
        const gw = normalizeGatewayKey(String(tx.gateway ?? ""));
        if (!gw) continue;
        keys.add(gw);
      }
    }

    pages += 1;
    const pageInfo = json.data?.orders?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }

  return keys;
}

async function ensureDefaultCash(shopId: string): Promise<void> {
  const existing = await prisma.paymentMethodMaster.findFirst({
    where: {
      shopId,
      OR: [
        { rawGatewayPattern: "cash", matchType: "exact_match" },
        { rawGatewayPattern: "Cash", matchType: "exact_match" },
        { category: "cash" },
      ],
    },
  });
  if (existing) return;
  await prisma.paymentMethodMaster.create({
    data: {
      shopId,
      rawGatewayPattern: "cash",
      matchType: "exact_match",
      displayLabel: "現金",
      category: "cash",
      sortOrder: 0,
      enabled: true,
      selectableForSpecialRefund: true,
    },
  });
}

/**
 * 直近 days 日の POS 取引から gateway を収集し、未登録分をマスタに自動作成する。
 */
export async function syncPaymentMethodsFromRecentOrders(
  admin: AdminClient,
  shopId: string,
  days = 90,
): Promise<PaymentMethodSyncResult> {
  await ensureDefaultCash(shopId);

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceIso = since.toISOString().slice(0, 10);
  const query = `created_at:>=${sinceIso} source_name:pos`;

  const gatewayKeys = await fetchGatewayKeysFromOrders(admin, query);
  const masters = await prisma.paymentMethodMaster.findMany({
    where: { shopId },
  });

  const matchesExisting = (gw: string): boolean => {
    const g = gw.toLowerCase();
    return masters.some((m) => {
      const p = m.rawGatewayPattern.toLowerCase();
      if (m.matchType === "exact_match") return g === p;
      if (m.matchType === "starts_with_match") return g.startsWith(p);
      return g.includes(p);
    });
  };

  let created = 0;
  let skipped = 0;
  const maxSort = masters.reduce((mx, m) => Math.max(mx, m.sortOrder), 0);

  for (const gw of gatewayKeys) {
    if (matchesExisting(gw)) {
      skipped += 1;
      continue;
    }
    const label = transactionDisplayName(gw, null);
    const isVoucher = /gift|voucher|商品券|ギフト/i.test(gw);
    const voucherChange = /釣有|釣り|change/i.test(gw);
    await prisma.paymentMethodMaster.create({
      data: {
        shopId,
        rawGatewayPattern: gw,
        matchType: "exact_match",
        displayLabel: label,
        category: isVoucher ? "voucher" : gw.toLowerCase() === "cash" ? "cash" : "uncategorized",
        sortOrder: maxSort + created + 1,
        isVoucher,
        voucherChangeSupported: voucherChange,
        voucherNoChangeSupported: isVoucher && !voucherChange,
        enabled: true,
        selectableForSpecialRefund: true,
      },
    });
    created += 1;
  }

  return {
    scannedOrderPages: 0,
    gatewaysFound: gatewayKeys.size,
    created,
    skipped,
  };
}
