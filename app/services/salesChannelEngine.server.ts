/**
 * Sales Channel Engine
 * チャネル別売上集計（仮想ロケーション）
 *
 * - POS ロケーションとは独立して動作する（retailLocation 照合なし）
 * - Shopify の source_name フィールドでチャネルを識別する
 * - 返金は updated_at ベースの 2 パスで集計（POS の settlementEngine と同方式）
 * - 実績 actual は税込（注文 totalPriceSet − 当日返金）を精算設定の税率で税抜に換算（buildSettlementPreview の netSales と同一式）
 * - キャッシュは SalesChannelCacheDaily に保存
 */
import prisma from "../db.server";
import { getShopTimezoneForDaily, getDayRangeInUtc, getDayRangeShopifySearchIso } from "../utils/shopTimezone.server";
import { getAppSetting, setAppSetting, SETTLEMENT_SETTINGS_KEY } from "../utils/appSettings.server";
import { splitTaxInclusiveToNetAndTax } from "./settlementEngine.server";

// ── 既知の source_name → 表示名マッピング ────────────────────────────────────

const KNOWN_CHANNEL_DISPLAY: Record<string, { name: string; shortName: string }> = {
  web:                      { name: "オンラインストア",    shortName: "EC"  },
  shop_app:                 { name: "Shop アプリ",        shortName: "Shop" },
  shopify_draft_orders:     { name: "下書き注文",          shortName: "下書" },
  android:                  { name: "Android アプリ",     shortName: "AND" },
  iphone:                   { name: "iPhone アプリ",      shortName: "iOS" },
  subscription_contract:    { name: "定期購入",            shortName: "定期" },
};

const CHANNEL_AUTO_DISCOVER_LAST_RUN_KEY = "channel_auto_discover_last_run";
const AUTO_DISCOVER_INTERVAL_MS = 60 * 60 * 1000; // 1時間に1回

const DISCOVER_SOURCE_NAMES_QUERY = `#graphql
  query DiscoverSourceNames($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        sourceName
        channelInformation {
          channelDefinition { channelName }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

/**
 * 直近の注文から source_name を自動検出し、未登録チャネルを DB に追加する。
 * 既存のチャネル設定（displayName・有効/無効など）は上書きしない。
 * 1時間以内に実行済みの場合はスキップ（forceScan=true で強制実行）。
 */
export async function autoDiscoverChannels(
  admin: AdminClient,
  shopId: string,
  { forceScan = false }: { forceScan?: boolean } = {},
): Promise<{ discovered: string[] }> {
  // スロットル: 最終実行から interval 未満ならスキップ
  if (!forceScan) {
    const lastRun = await getAppSetting<string>(shopId, CHANNEL_AUTO_DISCOVER_LAST_RUN_KEY);
    if (lastRun) {
      const elapsed = Date.now() - new Date(lastRun).getTime();
      if (elapsed < AUTO_DISCOVER_INTERVAL_MS) return { discovered: [] };
    }
  }

  // 直近30日の注文から source_name を収集（POS・精算除外・最大500件）
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const shopifyQuery = `created_at:>=${since} -status:cancelled tag_not:settlement -source_name:pos -source_name:point_of_sale -source_name:shopify_pos`;

  const sourceNameMap = new Map<string, string>(); // sourceName → channelName(hint)
  let cursor: string | null = null;
  let pages = 0;

  while (pages < 5) {
    const res = await admin.graphql(DISCOVER_SOURCE_NAMES_QUERY, {
      variables: { first: 100, after: cursor, query: shopifyQuery },
    });
    const json = await res.json() as {
      data?: {
        orders?: {
          nodes?: Array<{
            sourceName: string | null;
            channelInformation?: { channelDefinition?: { channelName?: string } | null } | null;
          }>;
          pageInfo?: { hasNextPage: boolean; endCursor: string };
        };
      };
    };
    const nodes = json.data?.orders?.nodes ?? [];
    for (const node of nodes) {
      const src = (node.sourceName ?? "").trim().toLowerCase();
      if (
        src &&
        src !== "pos" &&
        src !== "point_of_sale" &&
        src !== "shopify_pos" &&
        !src.includes("point_of_sale") &&
        !src.includes("shopify_pos") &&
        !sourceNameMap.has(src)
      ) {
        const hint = node.channelInformation?.channelDefinition?.channelName ?? "";
        sourceNameMap.set(src, hint);
      }
    }
    const pageInfo = json.data?.orders?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;
    pages++;
  }

  if (sourceNameMap.size === 0) {
    await setAppSetting(shopId, CHANNEL_AUTO_DISCOVER_LAST_RUN_KEY, new Date().toISOString());
    return { discovered: [] };
  }

  // 既存チャネルの sourceNamesJson を収集（重複登録を避ける）
  const existing = await prisma.salesChannel.findMany({ where: { shopId } });
  const registeredSources = new Set<string>();
  for (const ch of existing) {
    try {
      const names = JSON.parse(ch.sourceNamesJson) as string[];
      for (const n of names) registeredSources.add(n.toLowerCase());
    } catch { /* ignore */ }
  }

  // 新規 source_name を登録
  const discovered: string[] = [];
  let nextSortOrder = existing.length > 0 ? Math.max(...existing.map((c) => c.sortOrder)) + 10 : 10;

  for (const [src, hint] of sourceNameMap.entries()) {
    if (registeredSources.has(src)) continue;

    const known = KNOWN_CHANNEL_DISPLAY[src];
    const name = known?.name ?? (hint || src);
    const shortName = known?.shortName ?? src.slice(0, 4);

    // upsert で race condition による重複登録を防ぐ（既存の場合は表示名・設定を上書きしない）
    const existingForSrc = await prisma.salesChannel.findFirst({
      where: { shopId, sourceNamesJson: JSON.stringify([src]) },
    });
    if (existingForSrc) {
      registeredSources.add(src); // 今回のループ内での重複も防ぐ
      continue;
    }
    await prisma.salesChannel.create({
      data: {
        shopId,
        name,
        displayName: name,
        shortName,
        sortOrder: nextSortOrder,
        salesSummaryEnabled: true,
        includeInOverallTotals: false, // デフォルトはPOS合計に含めない（ユーザーが判断）
        sourceNamesJson: JSON.stringify([src]),
        sourceNamesSnapshot: "",
      },
    });
    discovered.push(src);
    nextSortOrder += 10;
  }

  await setAppSetting(shopId, CHANNEL_AUTO_DISCOVER_LAST_RUN_KEY, new Date().toISOString());
  return { discovered };
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChannelDailySummaryDTO {
  channelId: string;
  channelName: string;
  targetDate: string;
  actual: number;
  orders: number;
  items: number;
  budget: number | null;
  budgetRatio: number | null;
  atv: number | null;
  setRate: number | null;
  unit: number | null;
  currency: string;
}

// ── Shopify Types ──────────────────────────────────────────────────────────────

interface ChannelOrder {
  id: string;
  createdAt: string;
  sourceName: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  lineItems: { nodes: { quantity: number }[] };
  refunds: ChannelRefund[];
  tags: string[];
}

interface ChannelRefund {
  createdAt?: string;
  totalRefundedSet: { shopMoney: { amount: string; currencyCode: string } };
  refundLineItems?: { quantity: number }[];
}

interface OrderForRefundOverlay {
  id: string;
  sourceName: string | null;
  tags: string[];
  refunds: ChannelRefund[];
}

// ── GraphQL Queries ────────────────────────────────────────────────────────────

const CHANNEL_ORDERS_QUERY = `#graphql
  query ChannelOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      nodes {
        id
        createdAt
        sourceName
        totalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 250) {
          nodes { quantity }
        }
        refunds {
          createdAt
          refundLineItems(first: 250) {
            nodes { quantity }
          }
          totalRefundedSet { shopMoney { amount currencyCode } }
        }
        tags
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const CHANNEL_REFUNDS_QUERY = `#graphql
  query ChannelRefundsOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      nodes {
        id
        sourceName
        tags
        refunds {
          createdAt
          totalRefundedSet { shopMoney { amount currencyCode } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ── Query Builder ──────────────────────────────────────────────────────────────

/**
 * チャネル注文取得用 Shopify クエリ文字列を構築する。
 *
 * source_name によるフィルタリングは Shopify GraphQL の query 引数では
 * 信頼性が低いため、クエリレベルでは POS を除外するのみとし、
 * source_name の照合はフェッチ後にメモリ内で行う。
 */
function buildChannelQuery(
  dateField: "created_at" | "updated_at",
  startIso: string,
  endIso: string,
  extraFilters: string[] = []
): string {
  const parts: string[] = [];
  // POS 系は店舗ロケーション集計で扱う。source_name の表記が店舗で異なるため複数除外する
  parts.push("-source_name:pos");
  parts.push("-source_name:point_of_sale");
  parts.push("-source_name:shopify_pos");
  parts.push(`${dateField}:>=${startIso}`);
  parts.push(`${dateField}:<=${endIso}`);
  parts.push(...extraFilters);
  return parts.join(" ");
}

/** メモリ内 source_name フィルター（設定された sourceNames に一致する注文のみ返す） */
function filterBySourceNames<T extends { sourceName: string | null }>(
  orders: T[],
  sourceNames: string[]
): T[] {
  const nameSet = new Set(sourceNames.map((s) => s.toLowerCase()));
  return orders.filter((o) => {
    const src = (o.sourceName ?? "").toLowerCase();
    return nameSet.has(src);
  });
}

/** Shopify 検索の取りこぼし・境界ずれ対策: 注文 createdAt が日次範囲内か（UTC 境界は getDayRangeInUtc と同一） */
function orderCreatedAtInDayRange(
  createdAt: string | null | undefined,
  dayRange: { startUtc: Date; endUtc: Date }
): boolean {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return false;
  return t >= dayRange.startUtc.getTime() && t <= dayRange.endUtc.getTime();
}

// ── Fetch Helpers ──────────────────────────────────────────────────────────────

async function fetchChannelOrders(
  admin: AdminClient,
  query: string,
  dayRange?: { startUtc: Date; endUtc: Date }
): Promise<ChannelOrder[]> {
  const orders: ChannelOrder[] = [];
  const seenIds = new Set<string>(); // ページネーション重複排除
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(CHANNEL_ORDERS_QUERY, {
      variables: { first: 100, after: cursor, query },
    });
    const json = await response.json() as {
      errors?: { message: string }[];
      data?: {
        orders?: {
          nodes?: Array<ChannelOrder & {
            refunds?: Array<ChannelRefund & { refundLineItems?: { nodes?: { quantity: number }[] } | { quantity: number }[] }>;
          }>;
          pageInfo?: { hasNextPage: boolean; endCursor: string };
        };
      };
    };

    if (json.errors?.length) {
      throw new Error(`[salesChannelEngine] GraphQL error (query="${query}"): ${json.errors.map((e) => e.message).join(", ")}`);
    }

    const nodes = json.data?.orders?.nodes ?? [];
    const pageInfo = json.data?.orders?.pageInfo;

    for (const node of nodes) {
      if (seenIds.has(node.id)) continue; // 重複スキップ
      seenIds.add(node.id);
      const isSettlement = (node.tags ?? []).some((t) => String(t).toLowerCase() === "settlement");
      if (!isSettlement) {
        const co = node as ChannelOrder;
        if (dayRange && !orderCreatedAtInDayRange(co.createdAt, dayRange)) continue;
        orders.push({
          ...node,
          createdAt: co.createdAt,
          sourceName: co.sourceName ?? null,
          refunds: (node.refunds ?? []).map((r) => {
            const raw = r.refundLineItems as unknown;
            const refundLineItems: { quantity: number }[] = Array.isArray(raw)
              ? raw as { quantity: number }[]
              : (raw && typeof raw === "object" && "nodes" in raw)
                ? ((raw as { nodes?: { quantity: number }[] }).nodes ?? [])
                : [];
            return { ...r, refundLineItems };
          }),
        });
      }
    }

    hasNextPage = pageInfo?.hasNextPage ?? false;
    cursor = pageInfo?.endCursor ?? null;
  }

  return orders;
}

async function fetchChannelOrdersForRefundOverlay(
  admin: AdminClient,
  query: string
): Promise<OrderForRefundOverlay[]> {
  const orders: OrderForRefundOverlay[] = [];
  const seenIds = new Set<string>(); // ページネーション重複排除
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(CHANNEL_REFUNDS_QUERY, {
      variables: { first: 100, after: cursor, query },
    });
    const json = await response.json() as {
      errors?: { message: string }[];
      data?: {
        orders?: {
          nodes?: OrderForRefundOverlay[];
          pageInfo?: { hasNextPage: boolean; endCursor: string };
        };
      };
    };

    if (json.errors?.length) {
      throw new Error(`[salesChannelEngine] GraphQL error (refund overlay, query="${query}"): ${json.errors.map((e) => e.message).join(", ")}`);
    }

    const nodes = json.data?.orders?.nodes ?? [];
    const pageInfo = json.data?.orders?.pageInfo;

    for (const node of nodes) {
      if (seenIds.has(node.id)) continue; // 重複スキップ
      seenIds.add(node.id);
      const isSettlement = (node.tags ?? []).some((t) => String(t).toLowerCase() === "settlement");
      if (!isSettlement) {
        orders.push({
          id: node.id,
          sourceName: (node as OrderForRefundOverlay).sourceName ?? null,
          tags: node.tags,
          refunds: node.refunds ?? [],
        });
      }
    }

    hasNextPage = pageInfo?.hasNextPage ?? false;
    cursor = pageInfo?.endCursor ?? null;
  }

  return orders;
}

// ── 集計ロジック ───────────────────────────────────────────────────────────────

/** 当日作成注文から gross 売上・返金・商品数を集計 */
function computeChannelTotalsFromOrders(
  orders: ChannelOrder[],
  dayRange: { startUtc: Date; endUtc: Date }
): { gross: number; refund: number; items: number; currency: string } {
  let gross = 0;
  let refund = 0;
  let items = 0;
  let currency = "JPY";

  for (const order of orders) {
    gross += Number(order.totalPriceSet?.shopMoney?.amount ?? 0);
    currency = order.totalPriceSet?.shopMoney?.currencyCode ?? currency;

    for (const li of order.lineItems?.nodes ?? []) {
      items += li.quantity;
    }

    for (const r of order.refunds ?? []) {
      if (!r.createdAt) continue;
      const t = new Date(r.createdAt).getTime();
      if (t >= dayRange.startUtc.getTime() && t <= dayRange.endUtc.getTime()) {
        refund += Number(r.totalRefundedSet?.shopMoney?.amount ?? 0);
      }
    }
  }

  return { gross, refund, items, currency };
}

/**
 * 返金 overlay: 当日 updated_at で更新されたが当日 created_at ではない注文からの返金を拾う
 * （GAS overlayRefundsAndRecalc 相当、POS の settlementEngine と同方式）
 */
function computeRefundOverlay(
  ordersUpdated: OrderForRefundOverlay[],
  orderIdsCreatedInDay: Set<string>,
  dayRange: { startUtc: Date; endUtc: Date }
): number {
  let overlay = 0;
  for (const order of ordersUpdated) {
    if (orderIdsCreatedInDay.has(order.id)) continue;
    for (const r of order.refunds ?? []) {
      if (!r.createdAt) continue;
      const t = new Date(r.createdAt).getTime();
      if (t >= dayRange.startUtc.getTime() && t <= dayRange.endUtc.getTime()) {
        overlay += Number(r.totalRefundedSet?.shopMoney?.amount ?? 0);
      }
    }
  }
  return overlay;
}

// ── sourceNamesSnapshot によるキャッシュ有効性チェック ──────────────────────────

function isSnapshotMismatch(channel: { sourceNamesJson: string; sourceNamesSnapshot: string }): boolean {
  return channel.sourceNamesJson !== channel.sourceNamesSnapshot;
}

// ── メインエントリ ─────────────────────────────────────────────────────────────

export async function computeAndCacheChannelDailySummary(
  admin: AdminClient,
  shopId: string,
  channelId: string,
  channelName: string,
  sourceNames: string[],
  targetDate: string
): Promise<ChannelDailySummaryDTO> {
  if (sourceNames.length === 0) {
    throw new Error(`SalesChannel "${channelName}" has no sourceNames configured.`);
  }

  const timezone = await getShopTimezoneForDaily(admin, shopId);
  const dayRange = getDayRangeInUtc(targetDate, timezone);
  const searchIso = getDayRangeShopifySearchIso(targetDate, timezone);

  // Pass 1: created_at ベース（当日注文）
  // source_name は Shopify GraphQL の query 引数では信頼性が低いため除外し、
  // フェッチ後に sourceName フィールドでメモリ内フィルタリングする
  // 検索境界は GAS と同様 +09:00 壁時計（東京）を優先し、さらに createdAt で再フィルタする
  const createdQuery = buildChannelQuery(
    "created_at",
    searchIso.start,
    searchIso.end,
    ["tag_not:settlement", "-status:cancelled"]
  );
  const allCreatedOrders = await fetchChannelOrders(admin, createdQuery, dayRange);
  const orders = filterBySourceNames(allCreatedOrders, sourceNames);
  const orderIdsCreatedInDay = new Set(allCreatedOrders.map((o) => o.id)); // overlay 重複除外用は全件で持つ
  const { gross, refund: refundInDay, items, currency } = computeChannelTotalsFromOrders(orders, dayRange);

  // Pass 2: updated_at ベース返金 overlay（当日以外の注文から当日処理された返金）
  const updatedQuery = buildChannelQuery(
    "updated_at",
    searchIso.start,
    searchIso.end,
    ["tag_not:settlement"]
  );
  const allUpdatedOrders = await fetchChannelOrdersForRefundOverlay(admin, updatedQuery);
  const ordersUpdated = filterBySourceNames(allUpdatedOrders, sourceNames);
  const refundOverlay = computeRefundOverlay(ordersUpdated, orderIdsCreatedInDay, dayRange);

  const inclusiveActual = gross - refundInDay - refundOverlay;
  const settlementSettings = await getAppSetting<{ taxRatePercent?: number }>(shopId, SETTLEMENT_SETTINGS_KEY);
  const taxRatePercent = Number(settlementSettings?.taxRatePercent) || 10;
  const { netSales: actual } = splitTaxInclusiveToNetAndTax(inclusiveActual, taxRatePercent);
  const orderCount = orders.length;

  // 予算取得
  const budget = await prisma.salesChannelBudget?.findFirst?.({
    where: { shopId, channelId, targetDate },
  }).catch(() => null) ?? null;
  const budgetAmount: number | null = budget ? Number((budget as { amount: unknown }).amount) : null;

  // KPI 算出
  const budgetRatio = budgetAmount && budgetAmount > 0 ? actual / budgetAmount : null;
  const atv = orderCount > 0 ? actual / orderCount : null;
  const setRate = orderCount > 0 ? items / orderCount : null;
  const unit = items > 0 ? actual / items : null;

  // sourceNamesJson（マッピング変更検知用スナップショット）
  const sourceNamesJson = JSON.stringify([...sourceNames].sort());

  // キャッシュ保存
  await prisma.salesChannelCacheDaily.upsert({
    where: { shopId_channelId_targetDate: { shopId, channelId, targetDate } },
    update: {
      actual,
      orders: orderCount,
      items,
      budget: budgetAmount,
      budgetRatio,
      atv,
      setRate,
      unit,
      currency,
    },
    create: {
      shopId,
      channelId,
      targetDate,
      actual,
      orders: orderCount,
      items,
      budget: budgetAmount,
      budgetRatio,
      atv,
      setRate,
      unit,
      currency,
    },
  });

  // sourceNamesSnapshot を更新（マッピング変更検知のため）
  await prisma.salesChannel.update({
    where: { id: channelId },
    data: { sourceNamesSnapshot: sourceNamesJson },
  });

  return { channelId, channelName, targetDate, actual, orders: orderCount, items, budget: budgetAmount, budgetRatio, atv, setRate, unit, currency };
}

// ── キャッシュ読み取り（API エンドポイントから使用） ──────────────────────────────

export async function getChannelDailySummariesFromCache(
  shopId: string,
  channelIds: string[],
  targetDate: string
): Promise<ChannelDailySummaryDTO[]> {
  const channels = await prisma.salesChannel.findMany({
    where: { shopId, id: { in: channelIds }, salesSummaryEnabled: true },
  });
  const caches = await prisma.salesChannelCacheDaily.findMany({
    where: { shopId, channelId: { in: channelIds }, targetDate },
  });
  const cacheMap = new Map(caches.map((c) => [c.channelId, c]));

  return channels.map((ch) => {
    const c = cacheMap.get(ch.id);
    if (!c) return null;
    // sourceNamesSnapshot が現在設定と異なる場合、このキャッシュは古い（呼び出し元で再計算すること）
    if (isSnapshotMismatch(ch)) return null;
    return {
      channelId: ch.id,
      channelName: ch.displayName ?? ch.name,
      targetDate,
      actual: Number(c.actual),
      orders: c.orders,
      items: c.items,
      budget: c.budget ? Number(c.budget) : null,
      budgetRatio: c.budgetRatio ? Number(c.budgetRatio) : null,
      atv: c.atv ? Number(c.atv) : null,
      setRate: c.setRate ? Number(c.setRate) : null,
      unit: c.unit ? Number(c.unit) : null,
      currency: c.currency,
    };
  }).filter((r): r is ChannelDailySummaryDTO => r !== null);
}

/** 有効なチャネル一覧を返す（salesSummaryEnabled=true のみ） */
export async function getEnabledSalesChannels(shopId: string) {
  const channels = await prisma.salesChannel.findMany({
    where: { shopId, salesSummaryEnabled: true },
    orderBy: { sortOrder: "asc" },
  });
  return channels.map((ch) => ({
    id: ch.id,
    name: ch.name,
    displayName: ch.displayName ?? ch.name,
    shortName: ch.shortName,
    sortOrder: ch.sortOrder,
    includeInOverallTotals: ch.includeInOverallTotals,
    sourceNames: JSON.parse(ch.sourceNamesJson) as string[],
    sourceNamesJson: ch.sourceNamesJson,
    sourceNamesSnapshot: ch.sourceNamesSnapshot,
  }));
}
