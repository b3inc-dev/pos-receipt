/**
 * 旧運用のギフトカード「発行」実績を Shopify API から拾い、精算の支払バケットに足す。
 * - 対象日の createdAt がその日（店舗 TZ の日次範囲）に入るカードのみ
 * - 紐づく注文が当日 POS ユニオンに含まれる場合はスキップ（取引で既に計上済みの二重加算防止）
 * - 注文がある場合は retailLocation でロケーション一致、無い場合は GAS 同型 LOC:店名 をギフトカード note で判定
 */
import type { DayRangeUtc } from "../utils/shopTimezone.server";
import { adminGraphqlWithRetry, GRAPHQL_PAGE_DELAY_MS, sleep } from "../lib/shopifyGraphqlThrottle.server";

type AdminLike = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

const LEGACY_GIFT_CARDS_QUERY = `#graphql
  query LegacyGiftCards($first: Int!, $after: String, $query: String) {
    giftCards(first: $first, after: $after, query: $query) {
      edges {
        cursor
        node {
          id
          createdAt
          note
          initialValue { amount currencyCode }
          order {
            id
            retailLocation { id }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const LEGACY_GIFT_CARDS_FALLBACK_QUERY = `#graphql
  query LegacyGiftCardsFb($first: Int!, $after: String) {
    giftCards(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      edges {
        cursor
        node {
          id
          createdAt
          note
          initialValue { amount currencyCode }
          order {
            id
            retailLocation { id }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

function extractLocRaw(gid: string | null | undefined): string | null {
  if (!gid) return null;
  const s = String(gid).trim();
  const m = s.match(/\/(\d+)$/);
  return m?.[1] ?? (/^\d+$/.test(s) ? s : null);
}

function normalizeGiftCardNote(s: string): string {
  return String(s ?? "")
    .replace(/\u3000/g, " ")
    .replace(/：/g, ":")
    .replace(/\s*\|\s*/g, " | ")
    .trim();
}

/** GAS matchRefundFlags の LOC: 部分と同型 */
function locFromGiftCardNote(note: string | null | undefined): string {
  const s = normalizeGiftCardNote(note ?? "");
  const m = s.match(/\bLOC\s*:\s*([^|]+?)(?:\s*\||$)/i);
  return (m?.[1] ?? "").trim();
}

function retailLocationMatches(
  retailLocGid: string | null | undefined,
  settlementLocationId: string,
  locIdRaw: string,
): boolean {
  if (!retailLocGid) return false;
  const gid = settlementLocationId.startsWith("gid://")
    ? settlementLocationId
    : `gid://shopify/Location/${locIdRaw}`;
  const rRaw = extractLocRaw(retailLocGid);
  return retailLocGid === gid || rRaw === locIdRaw;
}

function giftCardMatchesSettlementLocation(
  note: string | null | undefined,
  orderRetailLocId: string | null | undefined,
  locationId: string,
  locationName: string,
  locIdRaw: string,
): boolean {
  if (orderRetailLocId) {
    return retailLocationMatches(orderRetailLocId, locationId, locIdRaw);
  }
  const locPart = locFromGiftCardNote(note);
  if (!locPart || !locationName.trim()) return false;
  return locPart === locationName.trim();
}

type GiftCardNode = {
  id: string;
  createdAt?: string | null;
  note?: string | null;
  initialValue?: { amount?: string | null } | null;
  order?: { id?: string | null; retailLocation?: { id?: string | null } | null } | null;
};

function processEdges(
  edges: { node: GiftCardNode }[],
  startMs: number,
  endMs: number,
  locationId: string,
  locationName: string,
  locIdRaw: string,
  posOrderIds: Set<string>,
  into: { amount: number; count: number },
): { stopPaging: boolean } {
  let stopPaging = false;
  for (const e of edges) {
    const n = e.node;
    const t = n.createdAt ? new Date(n.createdAt).getTime() : 0;
    if (t > endMs) continue;
    if (t < startMs) {
      stopPaging = true;
      break;
    }

    const oid = n.order?.id;
    if (oid && posOrderIds.has(oid)) continue;

    const rl = n.order?.retailLocation?.id ?? null;
    if (!giftCardMatchesSettlementLocation(n.note, rl, locationId, locationName, locIdRaw)) continue;

    const yen = Math.round(Number(n.initialValue?.amount ?? 0));
    if (yen > 0) {
      into.amount += yen;
      into.count += 1;
    }
  }
  return { stopPaging };
}

/**
 * 指定ロケーション・日次範囲で、POS 集計に未包含のギフトカード発行額を合算する。
 */
export async function fetchLegacyGiftCardIssuanceForDay(
  admin: AdminLike,
  dayRange: DayRangeUtc,
  locationId: string,
  locationName: string,
  posOrderIds: Set<string>,
): Promise<{ amount: number; count: number }> {
  const locIdRaw = locationId.replace("gid://shopify/Location/", "");
  const startMs = dayRange.startUtc.getTime();
  const endMs = dayRange.endUtc.getTime();
  const result = { amount: 0, count: 0 };

  const q = `created_at:>=${dayRange.startUtcIso} created_at:<=${dayRange.endUtcIso}`;

  let cursor: string | null = null;
  let hasNext = true;
  let usedFallback = false;

  while (hasNext) {
    const json = await adminGraphqlWithRetry<{
      data?: {
        giftCards?: {
          edges?: { node: GiftCardNode }[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      };
      errors?: { message?: string }[];
    }>(admin, LEGACY_GIFT_CARDS_QUERY, {
      variables: { first: 100, after: cursor, query: q },
    }, "legacyGiftCards");

    if (json.errors?.length) {
      usedFallback = true;
      break;
    }

    const edges = json.data?.giftCards?.edges ?? [];
    processEdges(edges, startMs, endMs, locationId, locationName, locIdRaw, posOrderIds, result);
    const pi = json.data?.giftCards?.pageInfo;
    hasNext = pi?.hasNextPage ?? false;
    cursor = pi?.endCursor ?? null;
    if (hasNext) await sleep(GRAPHQL_PAGE_DELAY_MS);
  }

  if (!usedFallback) {
    return result;
  }

  cursor = null;
  hasNext = true;
  result.amount = 0;
  result.count = 0;

  while (hasNext) {
    const json = await adminGraphqlWithRetry<{
      data?: {
        giftCards?: {
          edges?: { node: GiftCardNode }[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      };
      errors?: { message?: string }[];
    }>(admin, LEGACY_GIFT_CARDS_FALLBACK_QUERY, {
      variables: { first: 100, after: cursor },
    }, "legacyGiftCardsFallback");

    if (json.errors?.length) {
      return { amount: 0, count: 0 };
    }

    const edges = json.data?.giftCards?.edges ?? [];
    const { stopPaging } = processEdges(
      edges,
      startMs,
      endMs,
      locationId,
      locationName,
      locIdRaw,
      posOrderIds,
      result,
    );
    const pi = json.data?.giftCards?.pageInfo;
    hasNext = (pi?.hasNextPage ?? false) && !stopPaging;
    cursor = pi?.endCursor ?? null;
    if (edges.length === 0) hasNext = false;
    if (hasNext) await sleep(GRAPHQL_PAGE_DELAY_MS);
  }

  return result;
}
