/**
 * 入店数を ciara-system と見せ合う（純関数）。Ciara のカスタムアプリだけで使う（T 2026-11-24）。
 *
 * どちらも「読みにいくだけ」で、相手に書かない。店 × 日ごとに、人があとから入れたほうを出す（同じ時刻なら ciara-system の数）。
 * - POS の入店数（FootfallReport）は書き変えない。ciara-system の数は別の表（CiaraFootfallDaily）に写し、売上サマリーを出すときに比べる
 * - このアプリの時刻: FootfallReport.enteredAt（POS で人が入れた時刻）
 * - ciara-system の時刻: SalesStoreVisitDaily.reportedAt（人が入店数報告・売上サマリーで入れた時刻。CSV の取込では進まない）
 * POS で入れた数は、ciara-system が読む口（/api/external/ciara/footfall）から読みにくる。
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
  /** ciara-system の数が変わった日数（写しの表を書き変えた日数） */
  changed: number;
  /** 変わった日（多いときは初めの CIARA_VISIT_CHANGES_MAX 件だけ） */
  changes?: CiaraVisitChange[];
  /** このストアに同じロケーションが無い店（ciara-system の店名） */
  unmatched: string[];
};

/** ciara-system の数が変わった 1 日（前の数 → 新しい数。空は「数が無い」） */
export type CiaraVisitChange = { storeName: string; date: string; before: number | null; after: number | null };
export const CIARA_VISIT_CHANGES_MAX = 50;

export type CiaraVisitSyncSettings = {
  enabled: boolean;
  lastRun: CiaraVisitSyncLastRun | null;
};

export const DEFAULT_CIARA_VISIT_SYNC: CiaraVisitSyncSettings = {
  enabled: false,
  lastRun: null,
};

/** そろえる範囲（今日を含めて前の 35 日、古い順） */
export function visitSyncDateRange(todayYmd: string): string[] {
  const out: string[] = [];
  for (let i = CIARA_VISIT_SYNC_DAYS - 1; i >= 0; i--) out.push(addDaysToCalendarDate(todayYmd, -i));
  return out;
}

export type CiaraVisitDay = {
  date: string;
  visitCount: number;
  /** ciara-system で人が入れた時刻。空は前からの数（CSV の取込など）で、POS で入れた数より古いとみなす */
  reportedAt: string | null;
};
export type CiaraVisitStore = { shopifyLocationId: string; storeName: string; days: CiaraVisitDay[] };

/** ciara-system の返事（GET）を確かめる。形が違えば何も書かない */
export function parseCiaraVisitResponse(
  json: unknown,
  dates: string[],
): { ok: true; stores: CiaraVisitStore[] } | { ok: false; error: string } {
  const body = json as { ok?: unknown; stores?: unknown };
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
      const day = d as { date?: unknown; visitCount?: unknown; reportedAt?: unknown };
      const date = String(day?.date ?? "");
      const count = day?.visitCount;
      if (!inRange.has(date)) return { ok: false, error: "ciara-system の日付が頼んだ範囲の外です" };
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        return { ok: false, error: "ciara-system の入店数の形が違います" };
      }
      let reportedAt: string | null = null;
      if (day.reportedAt !== null && day.reportedAt !== undefined) {
        const t = Date.parse(String(day.reportedAt));
        if (Number.isNaN(t)) return { ok: false, error: "ciara-system の時刻の形が違います" };
        reportedAt = new Date(t).toISOString();
      }
      days.push({ date, visitCount: count, reportedAt });
    }
    stores.push({ shopifyLocationId: id, storeName: String(s.storeName ?? id), days });
  }
  return { ok: true, stores };
}

export type RemoteVisit = { visitCount: number; reportedAt: string | null };
/** 写しの表（CiaraFootfallDaily）に今ある数 */
export type StoredCiaraVisit = { visitors: number; reportedAt: string | null };

/**
 * ciara-system の今の数と、写しの表を見比べる（店 × 日。key = `${locationGid}|${date}`）。
 * - 新しい日・数か時刻が変わった日 → 書く
 * - ciara-system から消えた日（写しの表だけにある） → 消す
 * 同じなら何もしない。POS の入店数にはさわらない。
 */
export function planCiaraMirror(
  stored: Map<string, StoredCiaraVisit>,
  remote: Map<string, RemoteVisit>,
): { upserts: { key: string; before: number | null; visitCount: number; reportedAt: string | null }[]; deletes: { key: string; before: number }[] } {
  const upserts: { key: string; before: number | null; visitCount: number; reportedAt: string | null }[] = [];
  const deletes: { key: string; before: number }[] = [];
  for (const key of [...remote.keys()].sort()) {
    const r = remote.get(key)!;
    const s = stored.get(key);
    if (s && s.visitors === r.visitCount && s.reportedAt === r.reportedAt) continue;
    upserts.push({ key, before: s ? s.visitors : null, visitCount: r.visitCount, reportedAt: r.reportedAt });
  }
  for (const key of [...stored.keys()].sort()) {
    if (!remote.has(key)) deletes.push({ key, before: stored.get(key)!.visitors });
  }
  return { upserts, deletes };
}

export type DisplayedVisitors = { visitors: number; from: "pos" | "ciara" };

/**
 * 売上サマリーに出す入店数を決める（店 × 日）。人があとから入れたほうを出す。同じ時刻なら ciara-system の数（ciara-system 側と同じ決まり）。
 * - ciara-system の時刻が空（前からの数・CSV の取込）なら、POS の数があれば POS の数
 * - 片方だけならその数。どちらも無ければ空（未報告）
 */
export function pickDisplayedVisitors(
  pos: { visitors: number; enteredAt: string } | null,
  ciara: StoredCiaraVisit | null,
): DisplayedVisitors | null {
  if (!pos && !ciara) return null;
  if (!ciara) return { visitors: pos!.visitors, from: "pos" };
  if (!pos) return { visitors: ciara.visitors, from: "ciara" };
  if (ciara.reportedAt && Date.parse(ciara.reportedAt) >= Date.parse(pos.enteredAt)) {
    return { visitors: ciara.visitors, from: "ciara" };
  }
  return { visitors: pos.visitors, from: "pos" };
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
