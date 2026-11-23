/**
 * 店舗の「全店の決まり」と「店ごとの変更」の計算（prisma に触れない。画面とサーバーで共有）。
 *
 * 考え方:
 * - 精算・売上サマリーが読むのは今までどおり Location の列（この値は変えない）。
 * - 「全店の決まり」は AppSetting に 1 つ持つ。決まりを保存すると、決まりと同じ値だった店（全店と同じの店）の列を新しい値に書き換える。
 * - 決まりと違う値の店は「この店だけ変更」。その項目は決まりを変えてもそのまま残る。
 * - まだ決まりを保存していない店では、今いちばん多い値を仮の決まりとして見せる（保存するまで何も書かない）。
 */

export const LOCATION_DEFAULTS_KEY = "location_defaults";

/** 全店でそろえられる項目（どれも Location の真偽の列） */
export const DEFAULTABLE_KEYS = [
  "settlementEnabled",
  "receiptEnabled",
  "specialRefundEnabled",
  "voucherAdjustmentEnabled",
  "inspectionReceiptEnabled",
  "salesSummaryEnabled",
  "includeInStoreTotals",
  "includeInOverallTotals",
  "visibleInSummaryDefault",
  "budgetTargetEnabled",
] as const;

export type DefaultableKey = (typeof DEFAULTABLE_KEYS)[number];
export type LocationDefaults = Record<DefaultableKey, boolean>;

/** 画面の見出しと言葉。グループごとに並べる */
export const DEFAULT_GROUPS: { key: string; title: string; description: string; items: { key: DefaultableKey; label: string; short: string }[] }[] = [
  {
    key: "features",
    title: "POS で使う機能",
    description: "店の POS に出す機能です。使わない機能は、その店の POS に出ません。",
    items: [
      { key: "settlementEnabled", label: "精算", short: "精算" },
      { key: "receiptEnabled", label: "領収書", short: "領収書" },
      { key: "specialRefundEnabled", label: "特殊返金", short: "特殊返金" },
      { key: "voucherAdjustmentEnabled", label: "商品券の調整", short: "商品券" },
      { key: "inspectionReceiptEnabled", label: "点検レシート", short: "点検" },
    ],
  },
  {
    key: "totals",
    title: "売上の集計",
    description: "売上サマリーと予算で、この店をどう数えるかです。",
    items: [
      { key: "salesSummaryEnabled", label: "売上サマリーで集計する", short: "売上サマリー" },
      { key: "includeInStoreTotals", label: "店舗の合計に入れる", short: "店舗合計" },
      { key: "includeInOverallTotals", label: "全体の合計に入れる", short: "全体合計" },
      { key: "visibleInSummaryDefault", label: "売上サマリーを開いたときに表示する", short: "最初から表示" },
      { key: "budgetTargetEnabled", label: "予算の対象にする", short: "予算" },
    ],
  },
];

export const DEFAULTABLE_LABELS: Record<DefaultableKey, string> = Object.fromEntries(
  DEFAULT_GROUPS.flatMap((group) => group.items.map((item) => [item.key, item.label])),
) as Record<DefaultableKey, string>;

/** DB の列の初期値（prisma/schema.prisma の Location と同じ） */
export const SCHEMA_DEFAULTS: LocationDefaults = {
  settlementEnabled: true,
  receiptEnabled: true,
  specialRefundEnabled: true,
  voucherAdjustmentEnabled: true,
  inspectionReceiptEnabled: true,
  salesSummaryEnabled: false,
  includeInStoreTotals: true,
  includeInOverallTotals: true,
  visibleInSummaryDefault: true,
  budgetTargetEnabled: false,
};

export type StoredLocationDefaults = {
  defaults: LocationDefaults;
  /** 決まりを当てた店（Shopify のロケーション GID）。ここに無い店は、あとから足された店 */
  appliedLocationIds: string[];
  savedAt: string;
};

export type LocationValues = { id: string } & LocationDefaults;

export function readStoredDefaults(raw: unknown): StoredLocationDefaults | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<StoredLocationDefaults>;
  if (!value.defaults || typeof value.defaults !== "object") return null;
  const defaults = { ...SCHEMA_DEFAULTS };
  for (const key of DEFAULTABLE_KEYS) {
    const v = (value.defaults as Record<string, unknown>)[key];
    if (typeof v === "boolean") defaults[key] = v;
  }
  return {
    defaults,
    appliedLocationIds: Array.isArray(value.appliedLocationIds) ? value.appliedLocationIds.filter((id): id is string => typeof id === "string") : [],
    savedAt: typeof value.savedAt === "string" ? value.savedAt : "",
  };
}

/** まだ決まりが無いとき、今いちばん多い値を仮の決まりにする（同数なら DB の初期値） */
export function inferDefaults(locations: LocationValues[]): LocationDefaults {
  const result = { ...SCHEMA_DEFAULTS };
  for (const key of DEFAULTABLE_KEYS) {
    const on = locations.filter((loc) => loc[key]).length;
    const off = locations.length - on;
    if (on > off) result[key] = true;
    else if (off > on) result[key] = false;
  }
  return result;
}

/** 全店の決まりと違う項目（＝この店だけ変えている項目） */
export function differingKeys(location: LocationDefaults, defaults: LocationDefaults): DefaultableKey[] {
  return DEFAULTABLE_KEYS.filter((key) => location[key] !== defaults[key]);
}

export type LocationUpdate = { id: string; data: Partial<LocationDefaults> };

/**
 * 決まりを oldDefaults から newDefaults に変えるときに書き換える店と値。
 * 決まりと同じ値だった項目だけを新しい値にする。店ごとに変えている項目は残す。
 * lockedKeys（プランで使えない項目など）は変えない。
 */
export function planDefaultsChange(
  locations: LocationValues[],
  oldDefaults: LocationDefaults,
  newDefaults: LocationDefaults,
  lockedKeys: DefaultableKey[] = [],
): { updates: LocationUpdate[]; followingCount: number; customCount: number } {
  const changedKeys = DEFAULTABLE_KEYS.filter((key) => !lockedKeys.includes(key) && oldDefaults[key] !== newDefaults[key]);
  const updates: LocationUpdate[] = [];
  let customCount = 0;
  for (const loc of locations) {
    if (differingKeys(loc, oldDefaults).length > 0) customCount += 1;
    const data: Partial<LocationDefaults> = {};
    for (const key of changedKeys) {
      if (loc[key] === oldDefaults[key]) data[key] = newDefaults[key];
    }
    if (Object.keys(data).length > 0) updates.push({ id: loc.id, data });
  }
  return { updates, followingCount: locations.length - customCount, customCount };
}

/** 選んだ店をまとめて変える。changes に無い項目は変えない。今と同じ値の店は書かない */
export function planBulkChange(
  locations: LocationValues[],
  selectedIds: string[],
  changes: Partial<LocationDefaults>,
  lockedKeys: DefaultableKey[] = [],
): LocationUpdate[] {
  const selected = new Set(selectedIds);
  const updates: LocationUpdate[] = [];
  for (const loc of locations) {
    if (!selected.has(loc.id)) continue;
    const data: Partial<LocationDefaults> = {};
    for (const key of DEFAULTABLE_KEYS) {
      const next = changes[key];
      if (typeof next !== "boolean" || lockedKeys.includes(key)) continue;
      if (loc[key] !== next) data[key] = next;
    }
    if (Object.keys(data).length > 0) updates.push({ id: loc.id, data });
  }
  return updates;
}

/** その店を全店と同じに戻すときに書く値 */
export function resetToDefaults(location: LocationDefaults, defaults: LocationDefaults, lockedKeys: DefaultableKey[] = []): Partial<LocationDefaults> {
  const data: Partial<LocationDefaults> = {};
  for (const key of differingKeys(location, defaults)) {
    if (!lockedKeys.includes(key)) data[key] = defaults[key];
  }
  return data;
}

/** あとから Shopify に足された店（決まりを保存したあとに増えた店）。決まりがまだ無ければ空 */
export function newLocationIds(locationIds: string[], stored: StoredLocationDefaults | null): string[] {
  if (!stored) return [];
  const applied = new Set(stored.appliedLocationIds);
  return locationIds.filter((id) => !applied.has(id));
}

/** 「精算・領収書・特殊返金」のような 1 行の要約 */
export function featureSummary(values: LocationDefaults, groupKey: string): string {
  const group = DEFAULT_GROUPS.find((g) => g.key === groupKey);
  if (!group) return "";
  const on = group.items.filter((item) => values[item.key]).map((item) => item.short);
  return on.length === 0 ? "なし" : on.join("・");
}

/** フォームの値（チェックボックスは on のときだけ来る）から決まりを読む */
export function readDefaultsForm(form: { get(name: string): unknown }, fallback: LocationDefaults, lockedKeys: DefaultableKey[] = []): LocationDefaults {
  const result = { ...fallback };
  for (const key of DEFAULTABLE_KEYS) {
    if (lockedKeys.includes(key)) continue;
    result[key] = form.get(key) === "on";
  }
  return result;
}

/** まとめて変更のフォーム（項目ごとに「変えない」「使う」「使わない」）を読む */
export function readBulkForm(form: { get(name: string): unknown }): Partial<LocationDefaults> {
  const changes: Partial<LocationDefaults> = {};
  for (const key of DEFAULTABLE_KEYS) {
    const v = form.get(key);
    if (v === "on") changes[key] = true;
    else if (v === "off") changes[key] = false;
  }
  return changes;
}

/** Shopify のロケーション GID の数字の部分（画面の URL に使う） */
export function locationNumericId(gid: string): string {
  const m = /\/(\d+)$/.exec(gid);
  return m ? m[1] : gid;
}

export function locationGidFromNumeric(id: string): string | null {
  return /^\d+$/.test(id) ? `gid://shopify/Location/${id}` : null;
}
