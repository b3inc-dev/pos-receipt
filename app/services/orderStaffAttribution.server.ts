/**
 * 販売の帰属スタッフの記録と読み出し（DB・Shopify を呼ぶ側）
 *
 * - 記録: 注文 Webhook（orders/updated）の本文から、明細×スタッフの帰属を OrderStaffAttribution に入れ替える。
 *   Shopify への問い合わせはしない（本文だけで足りる）。注文は書き換えない。
 * - 読み出し: 注文 1 つの帰属スタッフ（ID・名前・数量）。名前は
 *   1) read_users がある店は Shopify の StaffMember の名前、2) 管理画面「スタッフ名」の登録、の順。
 *
 * 純粋な部分は app/utils/attributedStaff.ts。
 */
import prisma from "../db.server";
import { getAppSetting } from "../utils/appSettings.server";
import {
  STAFF_DISPLAY_NAMES_KEY,
  normalizeOrderId,
  parseOrderAttributionPayload,
  parseStaffDisplayNames,
  scopeIncludesReadUsers,
  staffMemberDisplayName,
  summarizeAttributedStaff,
  type AttributedStaff,
} from "../utils/attributedStaff";

type AdminGraphql = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export type RecordAttributionResult =
  | { status: "skipped"; reason: "no_order_id" | "stale" }
  | { status: "recorded"; orderId: string; rows: number };

/**
 * 注文 Webhook の本文から帰属を記録する（注文ごとに入れ替え）。
 * 帰属が 0 件の注文は、前に記録があれば消す（POS で帰属を外したとき）。無ければ何も書かない。
 * 届いた通知の updated_at が記録済みより古ければ捨てる（順番が入れ替わって届いたとき）。
 */
export async function recordOrderStaffAttributionFromWebhook(
  shopId: string,
  payload: unknown,
): Promise<RecordAttributionResult> {
  const parsed = parseOrderAttributionPayload(payload);
  if (!parsed) return { status: "skipped", reason: "no_order_id" };
  const { orderId, sourceUpdatedAt, lines } = parsed;

  return prisma.$transaction(async (tx) => {
    const latest = await tx.orderStaffAttribution.findFirst({
      where: { shopId, orderId },
      orderBy: { sourceUpdatedAt: { sort: "desc", nulls: "last" } },
      select: { sourceUpdatedAt: true },
    });
    if (latest?.sourceUpdatedAt && sourceUpdatedAt && sourceUpdatedAt < latest.sourceUpdatedAt) {
      return { status: "skipped", reason: "stale" } as const;
    }
    if (!latest && lines.length === 0) {
      return { status: "recorded", orderId, rows: 0 } as const;
    }
    await tx.orderStaffAttribution.deleteMany({ where: { shopId, orderId } });
    if (lines.length > 0) {
      await tx.orderStaffAttribution.createMany({
        data: lines.map((l) => ({
          shopId,
          orderId,
          lineItemId: l.lineItemId,
          position: l.position,
          staffId: l.staffId,
          quantity: l.quantity,
          sourceUpdatedAt,
        })),
        skipDuplicates: true,
      });
    }
    return { status: "recorded", orderId, rows: lines.length } as const;
  });
}

/** 管理画面「スタッフ名」の登録（ID → 表示名） */
export async function loadStaffDisplayNames(shopId: string): Promise<Record<string, string>> {
  const raw = await getAppSetting<unknown>(shopId, STAFF_DISPLAY_NAMES_KEY);
  return parseStaffDisplayNames(raw).names;
}

const STAFF_MEMBERS_QUERY = `#graphql
  query AttributedStaffNames($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on StaffMember { id name firstName lastName }
    }
  }
`;

/**
 * read_users がある店だけ、Shopify から StaffMember の名前を引く。
 * スコープが無い・失敗・見つからないときは空（呼び出し側は登録名か ID で出す）。
 */
export async function fetchShopifyStaffNames(
  admin: AdminGraphql | null | undefined,
  scope: string | null | undefined,
  staffIds: string[],
): Promise<Record<string, string>> {
  if (!admin || staffIds.length === 0 || !scopeIncludesReadUsers(scope)) return {};
  try {
    const res = await admin.graphql(STAFF_MEMBERS_QUERY, {
      variables: { ids: staffIds.slice(0, 50).map((id) => `gid://shopify/StaffMember/${id}`) },
    });
    const json = (await res.json()) as {
      data?: { nodes?: ({ id?: string; name?: string | null; firstName?: string | null; lastName?: string | null } | null)[] };
    };
    const out: Record<string, string> = {};
    for (const n of json.data?.nodes ?? []) {
      const m = n?.id ? /\/(\d+)$/.exec(n.id) : null;
      const name = staffMemberDisplayName(n);
      if (m && name) out[m[1]] = name;
    }
    return out;
  } catch {
    return {};
  }
}

export type OrderAttributedStaffResult = {
  /** 記録があるか（Webhook が届く前の注文・機能を入れる前の注文は false） */
  recorded: boolean;
  staffs: AttributedStaff[];
  /** 明細 ID（数字）→ その明細の帰属スタッフ */
  byLineItem: Record<string, AttributedStaff[]>;
};

/**
 * 注文 1 つの帰属スタッフ。
 * @param opts.admin / opts.scope read_users がある店で Shopify の名前を引くとき（無ければ登録名だけ）
 */
export async function getOrderAttributedStaff(
  shopId: string,
  orderIdRaw: unknown,
  opts: { admin?: AdminGraphql | null; scope?: string | null } = {},
): Promise<OrderAttributedStaffResult> {
  const orderId = normalizeOrderId(orderIdRaw);
  if (!orderId) return { recorded: false, staffs: [], byLineItem: {} };
  const rows = await prisma.orderStaffAttribution.findMany({
    where: { shopId, orderId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { lineItemId: true, position: true, staffId: true, quantity: true },
  });
  if (rows.length === 0) return { recorded: false, staffs: [], byLineItem: {} };

  const ids = [...new Set(rows.map((r) => r.staffId))];
  const [registered, fromShopify] = await Promise.all([
    loadStaffDisplayNames(shopId),
    fetchShopifyStaffNames(opts.admin, opts.scope, ids),
  ]);
  const names: Record<string, string> = { ...registered, ...fromShopify };

  const byLineItem: Record<string, AttributedStaff[]> = {};
  const grouped = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = grouped.get(r.lineItemId) ?? [];
    list.push(r);
    grouped.set(r.lineItemId, list);
  }
  for (const [lineItemId, list] of grouped) {
    byLineItem[lineItemId] = summarizeAttributedStaff(list, names);
  }
  return { recorded: true, staffs: summarizeAttributedStaff(rows, names), byLineItem };
}

/** 管理画面「スタッフ名」に並べる、記録に出てきたスタッフ ID（新しい順・最大 limit 人） */
export async function listRecordedStaffIds(shopId: string, limit = 200): Promise<string[]> {
  const rows = await prisma.orderStaffAttribution.groupBy({
    by: ["staffId"],
    where: { shopId },
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: "desc" } },
    take: limit,
  });
  return rows.map((r) => r.staffId);
}
