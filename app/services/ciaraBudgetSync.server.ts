/**
 * ciara-system の日別予算を 1 時間ごとに取り込む（Ciara のカスタムアプリだけ。T 2026-11-23）。
 *
 * - 自社用（APP_DISTRIBUTION=inhouse）でないときは何もしない。公開アプリでは設定も画面も出さない
 * - 鍵は環境変数 CIARA_BUDGET_SYNC_SECRET（ciara-system の POS_RECEIPT_BUDGET_SECRET と同じ値）、読む先は CIARA_SYSTEM_ORIGIN。無ければ止まっている
 * - 管理画面の設定で「取り込む」をオンにした店（ショップ）だけ動く
 * - 今月と来月の分を読み、Shopify のロケーションが同じ店の予算を ciara-system の値に合わせる
 * - 読むのは ciara-system・書くのはこのアプリの DB だけ。Shopify・ciara-system には書かない
 */
import prisma from "../db.server";
import { createCiaraSyncScheduler, type CiaraSchedulerStatus } from "./ciaraSyncScheduler.server";
import { getAppSetting } from "../utils/appSettings.server";
import { patchSyncSettings } from "./ciaraSyncSettingsPersistence.server";
import { isInhouseMode } from "../utils/planFeatures.server";
import { getCalendarDateStringInTimeZone, getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import {
  CIARA_BUDGET_SYNC_KEY,
  DEFAULT_CIARA_BUDGET_SYNC,
  diffSyncedStore,
  parseCiaraBudgetResponse,
  syncDateRange,
  type CiaraBudgetSyncSettings,
} from "../utils/ciaraBudgetSync";
import { applyBudgetDayChanges } from "./budgetWrite.server";
import { CIARA_BUDGETS_PATH, ciaraSystemUrl } from "./ciaraSystemOrigin.server";
import { expandLocationIdsForBudgetQuery } from "../utils/salesSummaryBudgetFromDb.server";

export const CIARA_BUDGET_SYNC_QUEUE = "pos-receipt-ciara-budget-sync";
const FETCH_TIMEOUT_MS = 20_000;

type AdminClient = { graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }> };

export function ciaraBudgetSyncAvailable(): boolean {
  return isInhouseMode();
}

export function ciaraBudgetSyncSecret(): string {
  return process.env.CIARA_BUDGET_SYNC_SECRET?.trim() ?? "";
}

/** サーバーの準備（合言葉と読む先）ができているか */
export function ciaraSyncServerReady(): boolean {
  return Boolean(ciaraBudgetSyncSecret() && ciaraSystemUrl(CIARA_BUDGETS_PATH));
}

export async function getCiaraBudgetSyncSettings(shopId: string): Promise<CiaraBudgetSyncSettings> {
  const saved = await getAppSetting<Partial<CiaraBudgetSyncSettings>>(shopId, CIARA_BUDGET_SYNC_KEY);
  return { ...DEFAULT_CIARA_BUDGET_SYNC, ...saved };
}

export async function saveCiaraBudgetSyncSettings(shopId: string, settings: Partial<CiaraBudgetSyncSettings>) {
  await patchSyncSettings(prisma.appSetting, shopId, CIARA_BUDGET_SYNC_KEY, DEFAULT_CIARA_BUDGET_SYNC, settings);
}

/** 取り込みがオンで、手入力を見るだけにする店（日別一覧・予算管理で使う） */
export async function getCiaraSyncedLocationIds(shopId: string): Promise<string[]> {
  if (!ciaraBudgetSyncAvailable()) return [];
  const s = await getCiaraBudgetSyncSettings(shopId);
  return s.enabled ? s.syncedLocationIds : [];
}

const LOCATIONS_QUERY = `#graphql
  query Locations {
    locations(first: 250, includeLegacy: false) {
      nodes { id name }
    }
  }
`;

/** 1 回取り込む。結果は設定の lastRun に残す（失敗しても前の予算は変えない） */
export async function runCiaraBudgetSync(shopId: string, admin: AdminClient): Promise<CiaraBudgetSyncSettings["lastRun"]> {
  const settings = await getCiaraBudgetSyncSettings(shopId);
  const finish = async (lastRun: NonNullable<CiaraBudgetSyncSettings["lastRun"]>, synced?: string[]) => {
    await saveCiaraBudgetSyncSettings(shopId, {
      lastRun,
      ...(synced === undefined ? {} : { syncedLocationIds: synced }),
    });
    return lastRun;
  };
  const base = { at: new Date().toISOString(), stores: 0, changed: 0, unmatched: [] as string[] };

  if (!ciaraBudgetSyncAvailable()) return finish({ ...base, ok: false, message: "このアプリでは使えません" });
  if (!settings.enabled) return finish({ ...base, ok: false, message: "取り込みがオフです" });
  const secret = ciaraBudgetSyncSecret();
  const endpoint = ciaraSystemUrl(CIARA_BUDGETS_PATH);
  if (!secret || !endpoint) return finish({ ...base, ok: false, message: "サーバーの準備がまだです" });

  const timezone = await getShopTimezoneForDaily(admin, shopId);
  const dates = syncDateRange(getCalendarDateStringInTimeZone(new Date(), timezone));
  const url = endpoint;
  url.searchParams.set("from", dates[0]);
  url.searchParams.set("to", dates[dates.length - 1]);

  let json: unknown;
  try {
    const res = await fetch(url, {
      headers: { "X-Cron-Secret": secret, Accept: "application/json" },
      // 転送先へ合言葉を持っていかない
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401) return finish({ ...base, ok: false, message: "ciara-system につなげませんでした（合言葉が合いません）" });
    if (res.status === 404) return finish({ ...base, ok: false, message: "ciara-system の読む口が止まっているか、URL が違います" });
    if (!res.ok) return finish({ ...base, ok: false, message: `ciara-system が失敗を返しました（${res.status}）` });
    json = await res.json();
  } catch (e) {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    return finish({ ...base, ok: false, message: timeout ? "ciara-system の返事が遅く、途中でやめました" : "ciara-system につながりませんでした" });
  }

  const parsed = parseCiaraBudgetResponse(json, dates);
  if (!parsed.ok) return finish({ ...base, ok: false, message: parsed.error });

  // Shopify のロケーションが同じ店だけを書く（このショップに無いロケーションは書かずに名前を残す）
  let shopLocationIds = new Set<string>();
  try {
    const locRes = await admin.graphql(LOCATIONS_QUERY);
    const locJson = (await locRes.json()) as { data?: { locations?: { nodes?: { id: string }[] } } };
    shopLocationIds = new Set((locJson.data?.locations?.nodes ?? []).map((l) => l.id));
  } catch {
    return finish({ ...base, ok: false, message: "Shopify のロケーションを読めませんでした" });
  }
  const matched = parsed.stores.filter((s) => shopLocationIds.has(`gid://shopify/Location/${s.shopifyLocationId}`));
  const unmatched = parsed.stores.filter((s) => !shopLocationIds.has(`gid://shopify/Location/${s.shopifyLocationId}`)).map((s) => s.storeName);

  const gids = matched.map((s) => `gid://shopify/Location/${s.shopifyLocationId}`);
  const variantToGid = new Map<string, string>();
  for (const g of gids) for (const v of expandLocationIdsForBudgetQuery(g)) variantToGid.set(v, g);
  const rows = gids.length === 0 ? [] : await prisma.budget.findMany({
    where: { shopId, locationId: { in: [...variantToGid.keys()] }, targetDate: { gte: dates[0], lte: dates[dates.length - 1] } },
    select: { locationId: true, targetDate: true, amount: true },
  });
  const current = new Map<string, Record<string, number>>(gids.map((g) => [g, {}]));
  for (const r of rows) {
    const g = variantToGid.get(r.locationId);
    if (!g) continue;
    const m = current.get(g)!;
    if (r.locationId === g || m[r.targetDate] === undefined) m[r.targetDate] = Number(r.amount);
  }

  let changed = 0;
  await prisma.$transaction(async (tx) => {
    for (const s of matched) {
      const gid = `gid://shopify/Location/${s.shopifyLocationId}`;
      const changes = diffSyncedStore(current.get(gid) ?? {}, s.days);
      changed += changes.length;
      await applyBudgetDayChanges(tx, shopId, gid, changes);
    }
  }, { timeout: 60_000 });

  return finish(
    {
      at: new Date().toISOString(),
      ok: true,
      message: changed > 0 ? `${changed} 日ぶんの予算を ciara-system に合わせました` : "変わった予算はありませんでした",
      stores: matched.length,
      changed,
      unmatched,
    },
    gids,
  );
}

const scheduler = createCiaraSyncScheduler({
  tag: "ciara-budget-sync",
  queue: CIARA_BUDGET_SYNC_QUEUE,
  // 1 時間ごとの取り込み（毎時 7 分・日本時間）
  cron: "7 * * * *",
  ready: () => ciaraBudgetSyncAvailable() && Boolean(ciaraBudgetSyncSecret()) && Boolean(ciaraSystemUrl(CIARA_BUDGETS_PATH)) && Boolean(process.env.DATABASE_URL?.trim()),
  work: async () => {
    const { unauthenticated } = await import("../shopify.server");
    const shops = await prisma.shop.findMany({ select: { id: true, shopDomain: true } });
    for (const shop of shops) {
      try {
        const s = await getCiaraBudgetSyncSettings(shop.id);
        if (!s.enabled) continue;
        const { admin } = await unauthenticated.admin(shop.shopDomain);
        const result = await runCiaraBudgetSync(shop.id, admin);
        console.log(`[ciara-budget-sync] shop=${shop.shopDomain} ok=${result?.ok} ${result?.message}`);
      } catch (e) {
        console.error(`[ciara-budget-sync] shop=${shop.shopDomain} failed`, e);
      }
    }
  },
});

/** 定期の仕事を始める（自社用で、サーバーの準備ができているときだけ。始まらなければ記録に出し、あとでもう一度始める） */
export function ensureCiaraBudgetSyncScheduler() {
  return scheduler.ensure();
}

/** 定期の仕事の今の状態（管理画面の「つながり」に出す） */
export function ciaraBudgetSyncSchedulerStatus(): CiaraSchedulerStatus {
  return scheduler.status();
}
