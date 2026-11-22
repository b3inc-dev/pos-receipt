/**
 * ギフトカードで払い出した返金を、精算の返金として数える（「精算の数え方」で ON にした店だけ）。
 *
 * 店頭の返品で、お金の代わりにギフトカードを渡す運用の店向け。ギフトカードのメモに
 * `REFUND_CASH` か `REFUND_GC` と `LOC:店の名前` を書いておき、その日の分を設定した支払方法（初めは現金）の返金に足す。
 * ciara-system の精算（GAS `sumRefundGiftCardsForDay`）と同じ見分け方。
 *
 * - メモに日付（`2026-11-22T10:00:00+09:00`・`DATE:2026-11-22`・`2026-11-22`・`2026/11/22`）があればその日、無ければ作った日で決める。
 *   日付だけのときは店のタイムゾーンの暦日として比べる。
 * - 取得に失敗したときは 0 円にせず、エラーにする（返金が抜けたまま精算を確定しない）。
 */
import type { DayRangeUtc } from "../utils/shopTimezone.server";
import { adminGraphqlWithRetry, GRAPHQL_PAGE_DELAY_MS, sleep } from "../lib/shopifyGraphqlThrottle.server";

type AdminLike = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

export type GiftCardRefundNode = {
  createdAt?: string | null;
  note?: string | null;
  initialValue?: { amount?: string | null } | null;
};

export class GiftCardRefundFetchError extends Error {
  constructor() {
    super(
      "ギフトカードの返金を Shopify から読めなかったため、精算を確定していません。少し待ってからもう一度精算してください。続くときは「精算の数え方」の「ギフトカードの返金」を確かめてください。",
    );
    this.name = "GiftCardRefundFetchError";
  }
}

const GIFT_CARD_REFUNDS_QUERY = `#graphql
  query SettlementGiftCardRefunds($first: Int!, $after: String, $query: String) {
    giftCards(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      edges {
        node {
          createdAt
          note
          initialValue { amount }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

type GiftCardRefundsConn = {
  edges?: { node: GiftCardRefundNode }[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
};
type GiftCardRefundsPage = { data?: { giftCards?: GiftCardRefundsConn }; errors?: unknown[] };

function normalizeNote(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/　/g, " ")
    .replace(/：/g, ":")
    .replace(/\s*\|\s*/g, " | ")
    .trim();
}

/** 店の名前のそろえ方（全角・半角、空白の有無を区別しない） */
export function locationNameKey(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

/** メモに返金の印（REFUND_CASH / REFUND_GC）があり、LOC: が店の名前のどれかと同じか */
export function matchGiftCardRefundNote(
  note: string | null | undefined,
  locationNameKeys: ReadonlySet<string>,
): boolean {
  const s = normalizeNote(note);
  if (!/\bREFUND_(?:CASH|GC(?:\|?1)?)\b/i.test(s)) return false;
  const m = s.match(/\bLOC\s*:\s*([^|]+?)(?:\s*\||$)/i);
  const loc = locationNameKey(m?.[1] ?? "");
  return loc !== "" && locationNameKeys.has(loc);
}

/**
 * メモの日付。時刻とオフセットがあれば瞬間（instant）、日付だけなら暦日（ymd）。無ければ null。
 */
export function giftCardRefundNoteDate(
  note: string | null | undefined,
): { instant: Date } | { ymd: string } | null {
  const s = String(note ?? "");
  const m1 = s.match(/\b(20\d{2}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?\b/);
  if (m1) {
    // オフセットの無い時刻はサーバーの時計で読まれてしまうので、日付だけで比べる
    if (m1[2]) {
      const d = new Date(m1[0]);
      if (Number.isFinite(d.getTime())) return { instant: d };
    }
    return { ymd: m1[1] };
  }
  const m2 = s.match(/\bDATE\s*:\s*(20\d{2}-\d{2}-\d{2})\b/i);
  if (m2) return { ymd: m2[1] };
  const m3 = s.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (m3) return { ymd: m3[1] };
  const m4 = s.match(/\b(20\d{2})\/(\d{1,2})\/(\d{1,2})\b/);
  if (m4) return { ymd: `${m4[1]}-${m4[2].padStart(2, "0")}-${m4[3].padStart(2, "0")}` };
  return null;
}

/** 取ってきたギフトカードから、その日・その店の返金を合計する（純関数） */
export function sumGiftCardRefunds(
  nodes: GiftCardRefundNode[],
  args: {
    targetDate: string;
    dayRange: Pick<DayRangeUtc, "startUtc" | "endUtc">;
    locationNameKeys: ReadonlySet<string>;
  },
): { amount: number; count: number } {
  const startMs = args.dayRange.startUtc.getTime();
  const endMs = args.dayRange.endUtc.getTime();
  const inDay = (d: Date) => d.getTime() >= startMs && d.getTime() <= endMs;
  let amount = 0;
  let count = 0;
  for (const n of nodes) {
    if (!matchGiftCardRefundNote(n.note, args.locationNameKeys)) continue;
    const noteDate = giftCardRefundNoteDate(n.note);
    let onDay: boolean;
    if (noteDate && "ymd" in noteDate) onDay = noteDate.ymd === args.targetDate;
    else if (noteDate) onDay = inDay(noteDate.instant);
    else onDay = !!n.createdAt && inDay(new Date(n.createdAt));
    if (!onDay) continue;
    const yen = Math.round(Number(n.initialValue?.amount ?? 0));
    if (yen > 0) {
      amount += yen;
      count += 1;
    }
  }
  return { amount, count };
}

/**
 * その日・その店のギフトカードの返金を Shopify から読んで合計する。
 * メモの日付と作った日がずれることがあるので、前後 2 日に作ったカードを読む。
 */
export async function fetchGiftCardRefundsForDay(
  admin: AdminLike,
  args: {
    targetDate: string;
    dayRange: DayRangeUtc;
    locationNames: string[];
  },
): Promise<{ amount: number; count: number }> {
  const locationNameKeys = new Set(args.locationNames.map(locationNameKey).filter(Boolean));
  if (locationNameKeys.size === 0) return { amount: 0, count: 0 };

  const startMs = args.dayRange.startUtc.getTime() - 2 * 24 * 60 * 60 * 1000;
  const endMs = args.dayRange.endUtc.getTime() + 2 * 24 * 60 * 60 * 1000;
  const startIso = new Date(startMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const endIso = new Date(endMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const query = `created_at:>=${startIso} created_at:<=${endIso}`;

  const nodes: GiftCardRefundNode[] = [];
  let cursor: string | null = null;
  let hasNext = true;
  while (hasNext) {
    const json: GiftCardRefundsPage = await adminGraphqlWithRetry<GiftCardRefundsPage>(
      admin,
      GIFT_CARD_REFUNDS_QUERY,
      { variables: { first: 100, after: cursor, query } },
      "giftCardRefunds",
    );
    const conn: GiftCardRefundsConn | undefined = json?.data?.giftCards;
    const pageInfo: GiftCardRefundsConn["pageInfo"] = conn?.pageInfo;
    if ((Array.isArray(json?.errors) && json.errors.length > 0) || !conn || typeof pageInfo?.hasNextPage !== "boolean") {
      throw new GiftCardRefundFetchError();
    }
    for (const e of conn.edges ?? []) if (e?.node) nodes.push(e.node);
    hasNext = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor ?? null;
    if (hasNext && !cursor) throw new GiftCardRefundFetchError();
    if (hasNext) await sleep(GRAPHQL_PAGE_DELAY_MS);
  }

  return sumGiftCardRefunds(nodes, {
    targetDate: args.targetDate,
    dayRange: args.dayRange,
    locationNameKeys,
  });
}
