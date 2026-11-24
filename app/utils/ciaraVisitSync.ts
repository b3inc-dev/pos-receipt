/**
 * 入店数を ciara-system と見せ合う（純関数）。Ciara のカスタムアプリだけで使う（T 2026-11-24）。
 *
 * どちらも「読みにいくだけ」で、相手に書かない。店 × 日ごとに、人があとから入れたほうを出す（同じ時刻なら ciara-system の数）。
 * - このアプリの時刻: FootfallReport.enteredAt（POS で入れた時刻、または ciara-system で人が入れた時刻）
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
  /** ciara-system の数をこのアプリに入れた日数 */
  pulled: number;
  /** このストアに同じロケーションが無い店（ciara-system の店名） */
  unmatched: string[];
};

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

export type LocalVisit = { visitors: number; enteredAt: string; source: string };
export type RemoteVisit = { visitCount: number; reportedAt: string | null };

/** 前からの数（ciara-system で入れた時刻が無い）を入れるときの「入れた時刻」。POS で入れた数がいつも新しくなる */
export const UNKNOWN_ENTERED_AT = "1970-01-01T00:00:00.000Z";

/**
 * 店 × 日（key = `${locationGid}|${date}`）ごとに、ciara-system の数をこのアプリに入れるかを決める（このアプリから外へは書かない）。
 * - ciara-system にだけある → 入れる
 * - 同じ数 → 何もしない
 * - 前に ciara-system から入れた数 → ciara-system の今の数に合わせる
 * - POS で入れた数 → ciara-system で人があとから入れたときだけ入れる（同じ時刻・時刻が無いときは POS の数のまま）
 */
export function planVisitPull(
  local: Map<string, LocalVisit>,
  remote: Map<string, RemoteVisit>,
): { key: string; visitCount: number; enteredAt: string }[] {
  const out: { key: string; visitCount: number; enteredAt: string }[] = [];
  for (const key of [...remote.keys()].sort()) {
    const r = remote.get(key)!;
    const l = local.get(key);
    const enteredAt = r.reportedAt ?? UNKNOWN_ENTERED_AT;
    if (!l) {
      out.push({ key, visitCount: r.visitCount, enteredAt });
      continue;
    }
    if (l.visitors === r.visitCount) continue;
    if (l.source !== "pos") {
      out.push({ key, visitCount: r.visitCount, enteredAt });
      continue;
    }
    if (r.reportedAt && Date.parse(r.reportedAt) > Date.parse(l.enteredAt)) {
      out.push({ key, visitCount: r.visitCount, enteredAt });
    }
  }
  return out;
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
