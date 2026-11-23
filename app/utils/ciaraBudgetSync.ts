/**
 * ciara-system から読んだ日別予算を、POS Receipt の予算に合わせる（純関数）。
 * Ciara のカスタムアプリだけで使う（公開アプリでは設定も画面も出さない）。
 */
import { addMonths, monthDays, type BudgetChange } from "./budgetMonthGrid";

export const CIARA_BUDGET_SYNC_KEY = "ciara_budget_sync";

export type CiaraBudgetSyncLastRun = {
  at: string;
  ok: boolean;
  message: string;
  stores: number;
  changed: number;
  unmatched: string[];
};

export type CiaraBudgetSyncSettings = {
  enabled: boolean;
  endpointUrl: string;
  /** 前回の取り込みで ciara-system の値を入れた店（この店は手入力を見るだけにする） */
  syncedLocationIds: string[];
  lastRun: CiaraBudgetSyncLastRun | null;
};

export const DEFAULT_CIARA_BUDGET_SYNC: CiaraBudgetSyncSettings = {
  enabled: false,
  endpointUrl: "",
  syncedLocationIds: [],
  lastRun: null,
};

export type CiaraBudgetStore = {
  shopifyLocationId: string;
  storeName: string;
  days: { date: string; amount: number | null }[];
};

/** 取り込む範囲: 今月の 1 日〜来月の末日 */
export function syncDateRange(todayYmd: string): string[] {
  const thisMonth = todayYmd.slice(0, 7);
  return [...monthDays(thisMonth), ...monthDays(addMonths(thisMonth, 1))].map((d) => d.date);
}

/** ciara-system の返事を確かめる。形が違えば何も書かない */
export function parseCiaraBudgetResponse(
  json: unknown,
  dates: string[],
): { ok: true; stores: CiaraBudgetStore[] } | { ok: false; error: string } {
  const body = json as { ok?: unknown; stores?: unknown };
  if (!body || body.ok !== true || !Array.isArray(body.stores)) {
    return { ok: false, error: "ciara-system の返事の形が違います" };
  }
  const inRange = new Set(dates);
  const stores: CiaraBudgetStore[] = [];
  for (const raw of body.stores as unknown[]) {
    const s = raw as { shopifyLocationId?: unknown; storeName?: unknown; days?: unknown };
    const id = String(s?.shopifyLocationId ?? "");
    if (!/^\d+$/.test(id) || !Array.isArray(s.days)) {
      return { ok: false, error: "ciara-system の店のデータの形が違います" };
    }
    const days: CiaraBudgetStore["days"] = [];
    for (const rawDay of s.days as unknown[]) {
      const d = rawDay as { date?: unknown; amount?: unknown };
      const date = String(d?.date ?? "");
      const amount = d?.amount;
      if (!inRange.has(date)) return { ok: false, error: `取り込む範囲でない日付があります（${date}）` };
      if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) {
        return { ok: false, error: `${date} の金額が正しくありません` };
      }
      days.push({ date, amount: amount === null ? null : Math.round((amount as number) * 100) / 100 });
    }
    stores.push({ shopifyLocationId: id, storeName: String(s.storeName ?? id), days });
  }
  return { ok: true, stores };
}

/**
 * 1 店ぶんの変わった日。ciara-system の範囲の日は ciara-system の値に合わせる（予算なしの日は消す）。
 * 返事に無い日は変えない。
 */
export function diffSyncedStore(
  current: Record<string, number>,
  days: CiaraBudgetStore["days"],
): BudgetChange[] {
  const changes: BudgetChange[] = [];
  for (const { date, amount } of days) {
    const before = current[date] ?? null;
    if (before === amount) continue;
    changes.push({
      date,
      before,
      after: amount,
      kind: amount === null ? "remove" : before === null ? "add" : "update",
    });
  }
  return changes;
}
