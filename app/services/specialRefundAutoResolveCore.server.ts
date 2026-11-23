/**
 * 返金処理中（pending）のまま数分たった特殊返金を、Shopify を読み直して success / failed に決める本体。
 * DB と Shopify は引数で受ける（試験で差し替えるため。prisma は import しない）。
 *
 * 二重返金を起こさないための決まり:
 * - Shopify は **読むだけ**（注文の返金の一覧）。refundCreate は呼ばない。
 * - DB は「active・pending・updatedAt が読んだときと同じ」行だけを 1 回だけ書き換える（楽観ロック）。
 *   POS の送り直しが同時に動いて pending に書き直したとき（updatedAt が変わる）や、
 *   店の人の「確かめる」が先に決めたときは、何も書かない。
 * - 決めたあとに POS から同じキーで送り直されても、POST /api/special-refunds は pending 以外を
 *   保存済みの結果として返すだけで、Shopify は呼ばない（今までどおり）。
 */
import {
  POS_SPECIAL_REFUND_EVENT_ID_PREFIX,
  type OrderRefundForRecheck,
} from "./specialRefundLegacyRecheck.server";
import {
  AUTO_RESOLVE_BATCH_LIMIT,
  decideAutoResolve,
  isStalePendingSpecialRefund,
  type AutoResolveDecision,
} from "./specialRefundAutoResolvePure.server";

export const ORDER_REFUNDS_FOR_AUTO_RESOLVE_QUERY = `#graphql
  query OrderRefundsForSpecialRefundAutoResolve($id: ID!) {
    order(id: $id) {
      id
      refunds {
        id
        note
        createdAt
        totalRefundedSet {
          shopMoney {
            amount
          }
        }
      }
    }
  }
`;

export type PendingSpecialRefundRow = {
  id: string;
  shopId: string;
  sourceOrderId: string;
  sourceOrderName: string | null;
  locationId: string;
  eventType: string;
  amount: number | string | { toString(): string };
  status: string;
  shopifyRefundStatus: string;
  shopifyRefundId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** prisma.specialRefundEvent のうち使う所だけ */
export type AutoResolveDb = {
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
    take?: number;
    select?: Record<string, boolean>;
  }): Promise<unknown[]>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
};

/** 注文の返金を読む。読めないときは null（その注文の登録は pending のまま次に回す） */
export type ReadOrderRefunds = (orderGid: string) => Promise<OrderRefundForRecheck[] | null>;

export type AutoResolveScope = {
  /** 精算の中から呼ぶとき: その日・そのロケーションの登録 */
  locationIds?: string[];
  createdFrom?: Date;
  createdTo?: Date;
  /** POS の注文の一覧から呼ぶとき */
  sourceOrderId?: string;
  /**
   * `pos_sr_` の登録（冪等キーあり）だけを見る。定期の見回りで使う。
   * 前からの登録は店の人が選ぶまで pending のままのことがあり、毎回の上限を埋めて
   * 新しい登録が後回しにならないようにする（前からの登録は精算と POS の一覧の中で見る）。
   */
  onlyKeyedEvents?: boolean;
};

export type AutoResolvedEvent = {
  id: string;
  sourceOrderId: string;
  sourceOrderName: string | null;
  locationId: string;
  createdAt: Date;
  status: "success" | "failed";
  refundId: string | null;
  reason: string;
};

export type AutoResolveResult = {
  checked: number;
  resolved: AutoResolvedEvent[];
  /** 前からの登録で、店の人が選ぶ必要があるもの */
  leftForStaff: string[];
  /** 読み直しの最中に、POS の送り直しや店の人の操作が先に決めた・書き直したもの */
  skippedConcurrent: string[];
  /** Shopify の注文を読めなかった注文 */
  readFailedOrders: string[];
};

export function orderGidOf(sourceOrderId: string): string {
  const s = String(sourceOrderId).trim();
  if (s.startsWith("gid://")) return s;
  return `gid://shopify/Order/${s.replace(/\D/g, "")}`;
}

export function buildStalePendingWhere(
  shopId: string,
  cutoff: Date,
  scope: AutoResolveScope,
): Record<string, unknown> {
  const where: Record<string, unknown> = {
    shopId,
    status: "active",
    shopifyRefundStatus: "pending",
    updatedAt: { lte: cutoff },
  };
  if (scope.locationIds && scope.locationIds.length > 0) {
    where.locationId = { in: [...new Set(scope.locationIds.filter(Boolean))] };
  }
  if (scope.createdFrom || scope.createdTo) {
    where.createdAt = {
      ...(scope.createdFrom ? { gte: scope.createdFrom } : {}),
      ...(scope.createdTo ? { lte: scope.createdTo } : {}),
    };
  }
  if (scope.sourceOrderId) where.sourceOrderId = scope.sourceOrderId;
  if (scope.onlyKeyedEvents) where.id = { startsWith: POS_SPECIAL_REFUND_EVENT_ID_PREFIX };
  return where;
}

function updateDataFor(decision: Exclude<AutoResolveDecision, { action: "leave" }>, now: Date) {
  if (decision.action === "success") {
    return {
      shopifyRefundStatus: "success",
      shopifyRefundId: decision.refundId,
      shopifyRefundError: null,
      shopifyRefundProcessedAt: now,
    };
  }
  return {
    shopifyRefundStatus: "failed",
    shopifyRefundError: decision.error,
    shopifyRefundProcessedAt: now,
  };
}

export async function resolveStalePendingSpecialRefundsCore(
  deps: { db: AutoResolveDb; readOrderRefunds: ReadOrderRefunds; now?: () => Date },
  shopId: string,
  scope: AutoResolveScope,
  opts: { afterMs: number; limit?: number },
): Promise<AutoResolveResult> {
  const now = deps.now ? deps.now() : new Date();
  const nowMs = now.getTime();
  const cutoff = new Date(nowMs - opts.afterMs);
  const afterMinutes = Math.round(opts.afterMs / 60000);
  const result: AutoResolveResult = {
    checked: 0,
    resolved: [],
    leftForStaff: [],
    skippedConcurrent: [],
    readFailedOrders: [],
  };

  const rows = (await deps.db.findMany({
    where: buildStalePendingWhere(shopId, cutoff, scope),
    orderBy: { updatedAt: "asc" },
    take: opts.limit ?? AUTO_RESOLVE_BATCH_LIMIT,
  })) as PendingSpecialRefundRow[];
  // DB の条件と同じことを、もう一度ここでも確かめる（試験・古い行の形に備える）
  const events = rows.filter((e) => isStalePendingSpecialRefund(e, nowMs, opts.afterMs));
  if (events.length === 0) return result;

  const byOrder = new Map<string, PendingSpecialRefundRow[]>();
  for (const e of events) {
    const list = byOrder.get(e.sourceOrderId) ?? [];
    list.push(e);
    byOrder.set(e.sourceOrderId, list);
  }

  // 前からの登録の判定で、ほかの登録にもう紐づいた返金を候補から外す
  const linkedRows = (await deps.db.findMany({
    where: {
      shopId,
      sourceOrderId: { in: [...byOrder.keys()] },
      shopifyRefundId: { not: null },
    },
    select: { id: true, sourceOrderId: true, shopifyRefundId: true },
  })) as Array<{ id: string; sourceOrderId: string; shopifyRefundId: string | null }>;
  const linkedByOrder = new Map<string, Set<string>>();
  for (const r of linkedRows) {
    if (!r.shopifyRefundId) continue;
    const set = linkedByOrder.get(r.sourceOrderId) ?? new Set<string>();
    set.add(r.shopifyRefundId);
    linkedByOrder.set(r.sourceOrderId, set);
  }

  for (const [sourceOrderId, orderEvents] of byOrder) {
    let refunds: OrderRefundForRecheck[] | null = null;
    try {
      refunds = await deps.readOrderRefunds(orderGidOf(sourceOrderId));
    } catch {
      refunds = null;
    }
    if (refunds == null) {
      result.readFailedOrders.push(sourceOrderId);
      continue;
    }
    const linked = linkedByOrder.get(sourceOrderId) ?? new Set<string>();
    // 古い登録から順に決める（同じ返金を 2 つの登録に紐づけない）
    const sorted = [...orderEvents].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const event of sorted) {
      result.checked += 1;
      const decision = decideAutoResolve(event, refunds, linked, afterMinutes);
      if (decision.action === "leave") {
        result.leftForStaff.push(event.id);
        continue;
      }
      if (decision.action === "success" && linked.has(decision.refundId)) {
        // 印が合うのにほかの登録に紐づいている（ありえないはず）。決めずに店の人へ回す
        result.leftForStaff.push(event.id);
        continue;
      }
      const updated = await deps.db.updateMany({
        where: {
          id: event.id,
          shopId,
          status: "active",
          shopifyRefundStatus: "pending",
          updatedAt: event.updatedAt,
        },
        data: updateDataFor(decision, now),
      });
      if (updated.count === 0) {
        result.skippedConcurrent.push(event.id);
        continue;
      }
      if (decision.action === "success") linked.add(decision.refundId);
      result.resolved.push({
        id: event.id,
        sourceOrderId: event.sourceOrderId,
        sourceOrderName: event.sourceOrderName,
        locationId: event.locationId,
        createdAt: event.createdAt,
        status: decision.action,
        refundId: decision.action === "success" ? decision.refundId : null,
        reason: decision.action === "success" ? decision.reason : "no_refund_in_shopify",
      });
    }
  }
  return result;
}
