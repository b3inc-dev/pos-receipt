/**
 * 入店数を ciara-system とそろえる（純関数）。Ciara のカスタムアプリだけで使う（T 2026-11-24）。
 *
 * 「どちらからでも報告でき、どちらにも最新の値が出る」ため、店 × 日ごとに、あとから入れたほうを採る。
 * - このアプリの時刻: FootfallReport.enteredAt（POS で入れた時刻、または ciara-system で入れた時刻）
 * - ciara-system の時刻: SalesStoreVisitDaily.updatedAt
 * 同じ値はどちらにも書かない（往復しても時刻が進まず、ぐるぐる回らない）。
 */
function addDaysToCalendarDate(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

export const CIARA_VISIT_SYNC_KEY = "ciara_visit_sync";
/** そろえる日数（今日を含めて前の 35 日） */
export const CIARA_VISIT_SYNC_DAYS = 35;

export type CiaraVisitSyncLastRun = {
  at: string;
  ok: boolean;
  message: string;
  /** ciara-system の数をこのアプリに入れた日数 */
  pulled: number;
  /** POS の数を ciara-system に入れた日数 */
  pushed: number;
  /** ciara-system の受け取りがオフで送れなかった */
  receiveOff: boolean;
  /** このストアに同じロケーションが無い店（ciara-system の店名） */
  unmatched: string[];
  /** ciara-system で入店数報告の対象でないため送れなかった店（ロケーション名か ID） */
  skipped: string[];
};

export type CiaraVisitSyncSettings = {
  enabled: boolean;
  endpointUrl: string;
  lastRun: CiaraVisitSyncLastRun | null;
};

export const DEFAULT_CIARA_VISIT_SYNC: CiaraVisitSyncSettings = {
  enabled: false,
  endpointUrl: "",
  lastRun: null,
};

/** そろえる範囲（今日を含めて前の 35 日、古い順） */
export function visitSyncDateRange(todayYmd: string): string[] {
  const out: string[] = [];
  for (let i = CIARA_VISIT_SYNC_DAYS - 1; i >= 0; i--) out.push(addDaysToCalendarDate(todayYmd, -i));
  return out;
}

export type CiaraVisitDay = { date: string; visitCount: number; updatedAt: string };
export type CiaraVisitStore = { shopifyLocationId: string; storeName: string; days: CiaraVisitDay[] };

/** ciara-system の返事（GET）を確かめる。形が違えば何も書かない */
export function parseCiaraVisitResponse(
  json: unknown,
  dates: string[],
): { ok: true; stores: CiaraVisitStore[]; receiveEnabled: boolean } | { ok: false; error: string } {
  const body = json as { ok?: unknown; stores?: unknown; receiveEnabled?: unknown };
  if (!body || body.ok !== true || !Array.isArray(body.stores)) {
    return { ok: false, error: "ciara-system の返事の形が違います" };
  }
  const inRange = new Set(dates);
  const stores: CiaraVisitStore[] = [];
  for (const raw of body.stores as unknown[]) {
    const s = raw as { shopifyLocationId?: unknown; storeName?: unknown; days?: unknown };
    const id = String(s?.shopifyLocationId ?? "");
    if (!/^\d+$/.test(id) || !Array.isArray(s.days)) {
      return { ok: false, error: "ciara-system の店のデータの形が違います" };
    }
    const days: CiaraVisitDay[] = [];
    for (const d of s.days as unknown[]) {
      const day = d as { date?: unknown; visitCount?: unknown; updatedAt?: unknown };
      const date = String(day?.date ?? "");
      const count = day?.visitCount;
      const updatedAt = String(day?.updatedAt ?? "");
      if (!inRange.has(date)) return { ok: false, error: "ciara-system の日付が頼んだ範囲の外です" };
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        return { ok: false, error: "ciara-system の入店数の形が違います" };
      }
      if (Number.isNaN(Date.parse(updatedAt))) return { ok: false, error: "ciara-system の時刻の形が違います" };
      days.push({ date, visitCount: count, updatedAt: new Date(updatedAt).toISOString() });
    }
    stores.push({ shopifyLocationId: id, storeName: String(s.storeName ?? id), days });
  }
  return { ok: true, stores, receiveEnabled: body.receiveEnabled === true };
}

export type LocalVisit = { visitors: number; enteredAt: string; source: string; pushedAt: string | null };
export type RemoteVisit = { visitCount: number; updatedAt: string };

export type VisitSyncPlan = {
  /** ciara-system の数をこのアプリに入れる */
  toLocal: { key: string; visitCount: number; updatedAt: string }[];
  /** POS の数を ciara-system に送る */
  toRemote: { key: string; visitCount: number; enteredAt: string }[];
  /** 同じ数だったので、送り終えた印だけ付ける */
  markPushed: string[];
};

/**
 * 店 × 日（key = `${locationGid}|${date}`）ごとに、どちらへ合わせるかを決める。
 * - ciara-system にだけある → このアプリへ
 * - このアプリにだけある（POS で入れた数）→ ciara-system へ
 * - 同じ数 → 何もしない（POS の数で送り終えていなければ印だけ付ける）
 * - 違う数 → あとから入れたほう。同じ時刻なら ciara-system の数（どちらの画面でも同じに見えるように）
 */
export function planVisitSync(local: Map<string, LocalVisit>, remote: Map<string, RemoteVisit>): VisitSyncPlan {
  const plan: VisitSyncPlan = { toLocal: [], toRemote: [], markPushed: [] };
  const keys = new Set([...local.keys(), ...remote.keys()]);
  for (const key of [...keys].sort()) {
    const l = local.get(key);
    const r = remote.get(key);
    if (r && !l) {
      plan.toLocal.push({ key, visitCount: r.visitCount, updatedAt: r.updatedAt });
      continue;
    }
    if (l && !r) {
      if (l.source === "pos") plan.toRemote.push({ key, visitCount: l.visitors, enteredAt: l.enteredAt });
      continue;
    }
    if (!l || !r) continue;
    if (l.visitors === r.visitCount) {
      if (l.source === "pos" && !l.pushedAt) plan.markPushed.push(key);
      continue;
    }
    const localNewer = Date.parse(l.enteredAt) > Date.parse(r.updatedAt);
    if (localNewer && l.source === "pos") {
      plan.toRemote.push({ key, visitCount: l.visitors, enteredAt: l.enteredAt });
    } else {
      plan.toLocal.push({ key, visitCount: r.visitCount, updatedAt: r.updatedAt });
    }
  }
  return plan;
}

export function visitKey(locationGid: string, date: string): string {
  return `${locationGid}|${date}`;
}

export function splitVisitKey(key: string): { locationGid: string; date: string } {
  const i = key.lastIndexOf("|");
  return { locationGid: key.slice(0, i), date: key.slice(i + 1) };
}

export function numericLocationId(locationGid: string): string {
  return locationGid.replace(/^gid:\/\/shopify\/Location\//, "");
}
