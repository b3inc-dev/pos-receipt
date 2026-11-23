/**
 * 売上サマリー設定の区分（要約の一覧 → 区分ごとの編集。Shop Point と同じ形。T 11/24 全画面点検）
 *
 * 保存は区分の項目だけを書き換え、ほかの区分の値はそのまま残す（読む側の SalesSummarySettings は変えない）。
 * サーバーとブラウザの両方で使うので、ここには DB・Shopify を書かない。
 */
import type { SalesSummarySettings } from "./appSettings.server";

export type SalesSummarySectionKey = "basic" | "display" | "numbers" | "footfall" | "link";

type BoolKey = {
  [K in keyof SalesSummarySettings]: SalesSummarySettings[K] extends boolean ? K : never;
}[keyof SalesSummarySettings];

export const SECTION_TITLES: Record<SalesSummarySectionKey, string> = {
  basic: "使い方",
  display: "出す店と行",
  numbers: "出す数字",
  footfall: "入店数の報告",
  link: "ブラウザで見るリンク",
};

export const SECTION_DESCRIPTIONS: Record<SalesSummarySectionKey, string> = {
  basic: "売上サマリーを使うか、1日・期間で見られるか、週の始まりを決めます。",
  display: "POS の売上サマリーに出す店と、合計などの行を決めます。",
  numbers: "売上サマリーに出す数字を選びます。外した数字は出ません。",
  footfall: "POS の売上サマリーから入店数を報告できるようにします。",
  link: "Shopify にログインしなくても、リンクを開くだけで全店の売上サマリーを見られます。",
};

export const SECTION_ORDER: SalesSummarySectionKey[] = ["basic", "display", "numbers", "footfall", "link"];

export function isSectionKey(value: string | undefined): value is SalesSummarySectionKey {
  return Boolean(value && (SECTION_ORDER as string[]).includes(value));
}

export const BASIC_CHECKS: { key: BoolKey; label: string }[] = [
  { key: "salesSummaryEnabled", label: "売上サマリーを使う" },
  { key: "allowSingleDateSummary", label: "1日の売上を見られるようにする" },
  { key: "allowDateRangeSummary", label: "期間（何日から何日まで）の売上を見られるようにする" },
];

export const DISPLAY_CHECKS: { key: BoolKey; label: string; help?: string }[] = [
  { key: "showLocationRows", label: "店ごとの行を出す" },
  { key: "showChannelRows", label: "EC などの行を出す", help: "「すべての店」を見ているときだけ出ます。1 店だけを見ているときは、その店の売上だけです。" },
  { key: "showChannelOnTile", label: "POS のタイルに EC などの売上も出す" },
  { key: "showStoreTotals", label: "店舗の合計を出す" },
  { key: "showOverallTotals", label: "全体の合計を出す" },
];

export const NUMBER_CHECKS: { key: BoolKey; label: string }[] = [
  { key: "showBudget", label: "予算" },
  { key: "showActual", label: "実績" },
  { key: "showBudgetRatio", label: "予算比" },
  { key: "showOrders", label: "注文数" },
  { key: "showVisitors", label: "入店数" },
  { key: "showConv", label: "購買率" },
  { key: "showAtv", label: "客単価" },
  { key: "showSetRate", label: "セット率" },
  { key: "showItems", label: "商品数" },
  { key: "showUnitPrice", label: "一品単価" },
  { key: "showMonthBudget", label: "月の予算" },
  { key: "showMonthActual", label: "月の実績" },
  { key: "showMonthAchvRatio", label: "月の達成率" },
  { key: "showProgressToday", label: "今日の進み" },
  { key: "showProgressPrev", label: "前日比" },
  { key: "showLoyaltyUsage", label: "ポイント利用額" },
];

export const FOOTFALL_CHECKS: { key: BoolKey; label: string }[] = [
  { key: "footfallReportEditableAfterSubmit", label: "送ったあとも直せるようにする" },
  { key: "footfallReportRequiresConfirmation", label: "送る前に確かめる画面を出す" },
];

const SECTION_BOOLS: Record<Exclude<SalesSummarySectionKey, "link">, BoolKey[]> = {
  basic: BASIC_CHECKS.map((c) => c.key),
  display: DISPLAY_CHECKS.map((c) => c.key),
  numbers: NUMBER_CHECKS.map((c) => c.key),
  footfall: ["footfallReportingEnabled", ...FOOTFALL_CHECKS.map((c) => c.key)],
};

/** 店の id の並び（空＝すべての店）。知らない id は捨てる */
function readIds(form: FormData, name: string, known: string[]): string[] {
  const ids = form.getAll(name).filter((v): v is string => typeof v === "string" && known.includes(v));
  const unique = [...new Set(ids)];
  return unique.length === known.length ? [] : unique;
}

/**
 * 区分のフォームから、その区分の項目だけを読む。チェックの無い欄は「しない」。
 * link の区分は設定の保存をしない（リンクの発行・パスワードは別の操作）。
 */
export function readSectionForm(
  section: Exclude<SalesSummarySectionKey, "link">,
  form: FormData,
  knownLocationIds: string[],
): Partial<SalesSummarySettings> {
  const out: Partial<SalesSummarySettings> = {};
  for (const key of SECTION_BOOLS[section]) (out as Record<string, boolean>)[key] = form.get(key) === "on";
  if (section === "basic") out.weekStartsOn = form.get("weekStartsOn") === "sunday" ? "sunday" : "monday";
  if (section === "display") out.visibleLocationIds = readIds(form, "visibleLocationIds", knownLocationIds);
  if (section === "numbers") {
    const label = String(form.get("loyaltyUsageSummaryLabel") ?? "").trim().slice(0, 30);
    out.loyaltyUsageSummaryLabel = label || "ポイント利用額";
  }
  if (section === "footfall") out.footfallTargetLocationIds = readIds(form, "footfallTargetLocationIds", knownLocationIds);
  return out;
}

function storeText(ids: string[], names: Map<string, string>, total: number): string {
  if (ids.length === 0) return `すべての店（${total} 店）`;
  const shown = ids.map((id) => names.get(id)).filter(Boolean) as string[];
  const head = shown.slice(0, 3).join("・");
  return shown.length > 3 ? `${head} ほか ${shown.length - 3} 店` : head || `${ids.length} 店`;
}

/** 一覧の 1 行の要約（今どうなっているか） */
export function sectionSummary(
  section: SalesSummarySectionKey,
  s: SalesSummarySettings,
  locations: { id: string; name: string }[],
  link: { active: boolean; passwordSet: boolean },
): string {
  const names = new Map(locations.map((l) => [l.id, l.name]));
  switch (section) {
    case "basic": {
      if (!s.salesSummaryEnabled) return "使わない";
      const views = [s.allowSingleDateSummary ? "1日" : "", s.allowDateRangeSummary ? "期間" : ""].filter(Boolean).join("と");
      return `使う・${views ? `${views}で見られる` : "見られる日の指定なし"}・週は${s.weekStartsOn === "sunday" ? "日曜" : "月曜"}始まり`;
    }
    case "display": {
      const rows = DISPLAY_CHECKS.filter((c) => s[c.key]).map((c) => c.label.replace(/を出す$|も出す$/, "").replace(/^POS のタイルに /, "タイルに "));
      return `${rows.length ? rows.join("・") : "行を出さない"}／出す店: ${storeText(s.visibleLocationIds, names, locations.length)}`;
    }
    case "numbers": {
      const on = NUMBER_CHECKS.filter((c) => s[c.key]).map((c) => c.label);
      if (on.length === NUMBER_CHECKS.length) return `すべて出す（${on.length} 個）`;
      if (on.length === 0) return "出さない";
      return `${on.length} 個: ${on.slice(0, 5).join("・")}${on.length > 5 ? " ほか" : ""}`;
    }
    case "footfall": {
      if (!s.footfallReportingEnabled) return "報告しない";
      return `報告する・${storeText(s.footfallTargetLocationIds, names, locations.length)}${s.footfallReportRequiresConfirmation ? "・送る前に確かめる" : ""}`;
    }
    case "link":
      if (!link.active) return "まだ発行していません";
      return `発行済み・${link.passwordSet ? "パスワードあり" : "パスワードなし（リンクを知っている人は見られます）"}`;
  }
}
