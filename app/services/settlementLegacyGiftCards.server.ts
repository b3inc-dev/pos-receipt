/**
 * 旧運用のギフトカード「発行」実績を Shopify API から拾い、精算の支払バケットに足す。
 * - 対象日の createdAt がその日（店舗 TZ の日次範囲）に入るカードのみ
 * - 紐づく注文が当日 POS ユニオンに含まれる場合はスキップ（取引で既に計上済みの二重加算防止）
 * - 注文がある場合は retailLocation でロケーション一致、無い場合は GAS 同型 LOC:店名 をギフトカード note で判定
 * - 取得が途中で失敗したら途中までの額を返さず止める（精算を確定しない）
 */
import { searchDateRange } from "../utils/shopifySearchDate";
import type { DayRangeUtc } from "../utils/shopTimezone.server";
import {
  adminGraphqlWithRetry,
  GRAPHQL_PAGE_DELAY_MS,
  isThrottledError,
  sleep,
  ThrottledExhaustedError,
} from "../lib/shopifyGraphqlThrottle.server";
import {
  LEGACY_GIFT_CARD_FAILURE_MESSAGE,
  UpstreamAggregationError,
} from "./settlementUpstreamPage.server";

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

type GiftCardsPage = {
  edges: { node: GiftCardNode }[];
  hasNextPage: boolean;
  endCursor: string | null;
};

/**
 * giftCards の 1 ページを読む。
 * - `"graphql-error"`: 応答に errors がある（主クエリなら代わりのクエリへ回す）。例外のときも fetchGiftCardsPage がこれにそろえる
 * - `"invalid"`: giftCards・pageInfo・cursor が欠けている（途中までで確定しない）
 * 注文ページの `readOrdersPageOrThrow` と同じ考え方。
 */
export function classifyGiftCardsPage(json: unknown): GiftCardsPage | "graphql-error" | "invalid" {
  if (!json || typeof json !== "object") return "invalid";
  const errors = (json as { errors?: unknown }).errors;
  if (errors != null) {
    if (!Array.isArray(errors)) return "invalid";
    if (errors.length > 0) return "graphql-error";
  }
  const giftCards = (json as { data?: { giftCards?: unknown } | null }).data?.giftCards;
  if (!giftCards || typeof giftCards !== "object") return "invalid";
  const pageInfo = (giftCards as { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } }).pageInfo;
  if (!pageInfo || typeof pageInfo.hasNextPage !== "boolean") return "invalid";
  if (pageInfo.hasNextPage && (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor.length === 0)) {
    return "invalid";
  }
  const edges = (giftCards as { edges?: unknown }).edges;
  if (edges != null && !Array.isArray(edges)) return "invalid";
  return {
    edges: (edges ?? []) as { node: GiftCardNode }[],
    hasNextPage: pageInfo.hasNextPage,
    endCursor: typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null,
  };
}

/**
 * giftCards を 1 ページ取る。
 * 本物の Shopify クライアント（admin.graphql）は、応答に errors があると JSON で返さず GraphqlQueryError を投げる
 * （`app/lib/customer.server.ts` の注記と同じ）。通信の失敗も例外になる。
 * Throttled の使い切りは「混雑しています」を出すためにそのまま上げ、それ以外の例外は errors と同じ `"graphql-error"` にそろえる。
 */
async function fetchGiftCardsPage(
  admin: AdminLike,
  query: string,
  variables: Record<string, unknown>,
  context: string,
): Promise<GiftCardsPage | "graphql-error" | "invalid"> {
  let json: unknown;
  try {
    json = await adminGraphqlWithRetry<unknown>(admin, query, { variables }, context);
  } catch (err) {
    if (err instanceof ThrottledExhaustedError || isThrottledError(err)) throw err;
    const name = err instanceof Error ? err.name : typeof err;
    console.warn("[settlement-upstream]", context, "exception", name);
    return "graphql-error";
  }
  return classifyGiftCardsPage(json);
}

function failLegacyGiftCards(context: string, reason: string): never {
  console.warn("[settlement-upstream]", context, "reject", reason);
  throw new UpstreamAggregationError(LEGACY_GIFT_CARD_FAILURE_MESSAGE);
}

/**
 * 指定ロケーション・日次範囲で、POS 集計に未包含のギフトカード発行額を合算する。
 *
 * 取得が途中で終わったとき（errors・ページ情報の欠け・例外）は 0 円や途中までの額を返さず、
 * `UpstreamAggregationError`（日本語の案内）を投げる。精算・売上サマリーは不完全な集計を確定しない（#16 と同じ）。
 * 主クエリ（created_at の絞り込み）が errors か例外（GraphqlQueryError 等）のときは、従来どおり新しい順の全件走査に切り替える。
 * Throttled の使い切り（ThrottledExhaustedError）だけはそのまま上げる（精算 API が「混雑しています」を出す）。
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

  const q = searchDateRange("created_at", dayRange.startUtcIso, dayRange.endUtcIso);

  let cursor: string | null = null;
  let hasNext = true;
  let usedFallback = false;

  while (hasNext) {
    const page = await fetchGiftCardsPage(
      admin,
      LEGACY_GIFT_CARDS_QUERY,
      { first: 100, after: cursor, query: q },
      "legacyGiftCards",
    );
    if (page === "graphql-error") {
      usedFallback = true;
      break;
    }
    if (page === "invalid") failLegacyGiftCards("legacyGiftCards", "invalid-page");

    processEdges(page.edges, startMs, endMs, locationId, locationName, locIdRaw, posOrderIds, result);
    hasNext = page.hasNextPage;
    cursor = page.endCursor;
    if (hasNext) await sleep(GRAPHQL_PAGE_DELAY_MS);
  }

  if (!usedFallback) {
    return result;
  }

  // 主クエリの途中まで足した分は捨てて、最初から数え直す
  cursor = null;
  hasNext = true;
  result.amount = 0;
  result.count = 0;

  while (hasNext) {
    const page = await fetchGiftCardsPage(
      admin,
      LEGACY_GIFT_CARDS_FALLBACK_QUERY,
      { first: 100, after: cursor },
      "legacyGiftCardsFallback",
    );
    if (page === "graphql-error") failLegacyGiftCards("legacyGiftCardsFallback", "graphql-error");
    if (page === "invalid") failLegacyGiftCards("legacyGiftCardsFallback", "invalid-page");

    const { stopPaging } = processEdges(
      page.edges,
      startMs,
      endMs,
      locationId,
      locationName,
      locIdRaw,
      posOrderIds,
      result,
    );
    hasNext = page.hasNextPage && !stopPaging;
    cursor = page.endCursor;
    if (page.edges.length === 0) hasNext = false;
    if (hasNext) await sleep(GRAPHQL_PAGE_DELAY_MS);
  }

  return result;
}
