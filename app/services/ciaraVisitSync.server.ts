/**
 * 入店数を ciara-system と見せ合う（Ciara のカスタムアプリだけ。T 2026-11-24「どの店も両方使えて、どちらも報告があった時点で反映」）。
 *
 * どちらも「読みにいくだけ」で、相手に書かない。
 * - ciara-system → このアプリ: 5 分ごとと、POS で売上サマリーを開いたとき（1 分に 1 回まで・待たせない）に、
 *   ciara-system の読む口から今日を含めた前の 35 日の入店数を読み、別の表 CiaraFootfallDaily に写す（POS の入店数は書き変えない）。
 *   売上サマリーを出すときに POS の数と比べ、人があとから入れたほうを出す（footfallWrite.server.ts の getDisplayedVisitors）。
 *   オフにすると写しは使わず、POS で入れた数だけに戻る
 * - このアプリ → ciara-system: ciara-system が /api/external/ciara/footfall を読みにくる（POS で入れた数だけを渡す）
 *
 * - 自社用（APP_DISTRIBUTION=inhouse）でないときは何もしない。公開アプリでは設定も画面も出さない
 * - 合言葉は予算と同じ CIARA_BUDGET_SYNC_SECRET、読む先は CIARA_SYSTEM_ORIGIN（管理画面からは変えられない）
 * - 管理画面で「見せ合う」をオンにしたショップだけ動く（既定オフ）
 */
import prisma from "../db.server";
import { createCiaraSyncScheduler, type CiaraSchedulerStatus } from "./ciaraSyncScheduler.server";
import { getAppSetting, setAppSetting } from "../utils/appSettings.server";
import { isInhouseMode } from "../utils/planFeatures.server";
import { getCalendarDateStringInTimeZone, getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import {
  CIARA_VISIT_SYNC_KEY,
  DEFAULT_CIARA_VISIT_SYNC,
  parseCiaraVisitResponse,
  CIARA_VISIT_CHANGES_MAX,
  planCiaraMirror,
  splitVisitKey,
  visitKey,
  visitSyncDateRange,
  type CiaraVisitSyncLastRun,
  type CiaraVisitSyncSettings,
  type CiaraVisitChange,
  type RemoteVisit,
  type StoredCiaraVisit,
} from "../utils/ciaraVisitSync";
import { ciaraBudgetSyncSecret } from "./ciaraBudgetSync.server";
import { CIARA_VISITS_PATH, ciaraSystemUrl } from "./ciaraSystemOrigin.server";
import { refreshCachedVisitors } from "./footfallWrite.server";

export const CIARA_VISIT_SYNC_QUEUE = "pos-receipt-ciara-visit-sync";
const FETCH_TIMEOUT_MS = 20_000;
/** 売上サマリーを開いたときに読むのは、前に読んでからこれより時間がたったときだけ */
const OPEN_KICK_INTERVAL_MS = 60_000;

type AdminClient = { graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }> };

export function ciaraVisitSyncAvailable(): boolean {
  return isInhouseMode();
}

/** サーバーの準備（合言葉と読む先）ができているか */
export function ciaraVisitSyncServerReady(): boolean {
  return Boolean(ciaraBudgetSyncSecret() && ciaraSystemUrl(CIARA_VISITS_PATH));
}

export async function getCiaraVisitSyncSettings(shopId: string): Promise<CiaraVisitSyncSettings> {
  const saved = await getAppSetting<Partial<CiaraVisitSyncSettings>>(shopId, CIARA_VISIT_SYNC_KEY);
  return { ...DEFAULT_CIARA_VISIT_SYNC, ...saved };
}

export async function saveCiaraVisitSyncSettings(shopId: string, settings: CiaraVisitSyncSettings) {
  await setAppSetting(shopId, CIARA_VISIT_SYNC_KEY, settings);
}

/**
 * 見せ合うのオン・オフを変えたとき、ciara-system の数がある日の控え（売上サマリーの日次）を、出す数で直す。
 * オフにすると POS で入れた数だけに戻る（写しの表は消さない。オンに戻せばまた使う）。
 */
export async function refreshCachedVisitorsForCiaraDays(shopId: string, shown: boolean) {
  const rows = await prisma.ciaraFootfallDaily.findMany({
    where: { shopId },
    select: { locationId: true, targetDate: true },
  });
  for (const r of rows) await refreshCachedVisitors(prisma, shopId, r.locationId, r.targetDate, shown);
}

const LOCATIONS_QUERY = `#graphql
  query Locations {
    locations(first: 250, includeLegacy: false) {
      nodes { id name }
    }
  }
`;

/** 1 回読む。結果は設定の lastRun に残す（失敗してもこのアプリの入店数は変えない） */
export async function runCiaraVisitSync(shopId: string, admin: AdminClient): Promise<CiaraVisitSyncLastRun> {
  const settings = await getCiaraVisitSyncSettings(shopId);
  const base: CiaraVisitSyncLastRun = { at: new Date().toISOString(), ok: false, message: "", changed: 0, unmatched: [] };
  const finish = async (lastRun: CiaraVisitSyncLastRun) => {
    const latest = await getCiaraVisitSyncSettings(shopId);
    await saveCiaraVisitSyncSettings(shopId, { ...latest, lastRun });
    return lastRun;
  };

  if (!ciaraVisitSyncAvailable()) return finish({ ...base, message: "このアプリでは使えません" });
  if (!settings.enabled) return finish({ ...base, message: "見せ合う設定がオフです" });
  const secret = ciaraBudgetSyncSecret();
  const endpoint = ciaraSystemUrl(CIARA_VISITS_PATH);
  if (!secret || !endpoint) return finish({ ...base, message: "サーバーの準備がまだです" });

  const timezone = await getShopTimezoneForDaily(admin, shopId);
  const dates = visitSyncDateRange(getCalendarDateStringInTimeZone(new Date(), timezone));
  endpoint.searchParams.set("from", dates[0]);
  endpoint.searchParams.set("to", dates[dates.length - 1]);

  let json: unknown;
  try {
    const res = await fetch(endpoint, {
      headers: { "X-Cron-Secret": secret, Accept: "application/json" },
      // 転送先へ合言葉を持っていかない
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401) return finish({ ...base, message: "ciara-system につなげませんでした（合言葉が合いません）" });
    if (res.status === 404) return finish({ ...base, message: "ciara-system の入店数の口が止まっています" });
    if (!res.ok) return finish({ ...base, message: `ciara-system が失敗を返しました（${res.status}）` });
    json = await res.json();
  } catch (e) {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    return finish({ ...base, message: timeout ? "ciara-system の返事が遅く、途中でやめました" : "ciara-system につながりませんでした" });
  }
  const parsed = parseCiaraVisitResponse(json, dates);
  if (!parsed.ok) return finish({ ...base, message: parsed.error });

  let shopLocationIds = new Set<string>();
  try {
    const locRes = await admin.graphql(LOCATIONS_QUERY);
    const locJson = (await locRes.json()) as { data?: { locations?: { nodes?: { id: string }[] } } };
    shopLocationIds = new Set((locJson.data?.locations?.nodes ?? []).map((l) => l.id));
  } catch {
    return finish({ ...base, message: "Shopify のロケーションを読めませんでした" });
  }

  const remote = new Map<string, RemoteVisit>();
  const storeNameByGid = new Map<string, string>();
  const unmatched: string[] = [];
  for (const s of parsed.stores) {
    const gid = `gid://shopify/Location/${s.shopifyLocationId}`;
    if (!shopLocationIds.has(gid)) {
      if (s.days.length > 0) unmatched.push(s.storeName);
      continue;
    }
    storeNameByGid.set(gid, s.storeName);
    for (const d of s.days) remote.set(visitKey(gid, d.date), { visitCount: d.visitCount, reportedAt: d.reportedAt });
  }

  const storedRows = await prisma.ciaraFootfallDaily.findMany({
    where: { shopId, targetDate: { gte: dates[0], lte: dates[dates.length - 1] } },
    select: { locationId: true, targetDate: true, visitors: true, reportedAt: true },
  });
  const stored = new Map<string, StoredCiaraVisit>(
    storedRows.map((r) => [visitKey(r.locationId, r.targetDate), { visitors: r.visitors, reportedAt: r.reportedAt?.toISOString() ?? null }]),
  );

  const plan = planCiaraMirror(stored, remote);
  const changes: CiaraVisitChange[] = [];
  const nameOf = (gid: string) => storeNameByGid.get(gid) ?? gid.replace(/^gid:\/\/shopify\/Location\//, "");
  const now = new Date();
  for (const u of plan.upserts) {
    const { locationGid, date } = splitVisitKey(u.key);
    const reportedAt = u.reportedAt ? new Date(u.reportedAt) : null;
    await prisma.ciaraFootfallDaily.upsert({
      where: { shopId_locationId_targetDate: { shopId, locationId: locationGid, targetDate: date } },
      update: { visitors: u.visitCount, reportedAt, fetchedAt: now },
      create: { shopId, locationId: locationGid, targetDate: date, visitors: u.visitCount, reportedAt, fetchedAt: now },
    });
    await refreshCachedVisitors(prisma, shopId, locationGid, date, true);
    if (u.before !== u.visitCount) changes.push({ storeName: nameOf(locationGid), date, before: u.before, after: u.visitCount });
  }
  for (const d of plan.deletes) {
    const { locationGid, date } = splitVisitKey(d.key);
    await prisma.ciaraFootfallDaily.deleteMany({ where: { shopId, locationId: locationGid, targetDate: date } });
    await refreshCachedVisitors(prisma, shopId, locationGid, date, true);
    changes.push({ storeName: nameOf(locationGid), date, before: d.before, after: null });
  }
  if (changes.length > 0) {
    // 前の数 → 新しい数をログにも残す（画面には初めの 50 件）
    console.log(`[ciara-visit-sync] shop=${shopId} changes=${JSON.stringify(changes)}`);
  }

  return finish({
    at: new Date().toISOString(),
    ok: true,
    message: changes.length > 0 ? `ciara-system の入店数が ${changes.length} 日ぶん変わりました` : "変わった入店数はありませんでした",
    changed: changes.length,
    changes: changes.slice(0, CIARA_VISIT_CHANGES_MAX),
    unmatched,
  });
}

const lastKickAt = new Map<string, number>();

/**
 * POS で売上サマリーを開いたときに呼ぶ（待たせない。失敗しても POS の数で出す）。1 分に 1 回まで。
 * 読んだ数は次に開いたとき（全店表示なら数え直しの返事）から出る。
 */
export function kickCiaraVisitSyncOnOpen(shopId: string, admin: AdminClient): void {
  if (!ciaraVisitSyncAvailable() || !ciaraVisitSyncServerReady()) return;
  const now = Date.now();
  if (now - (lastKickAt.get(shopId) ?? 0) < OPEN_KICK_INTERVAL_MS) return;
  lastKickAt.set(shopId, now);
  void (async () => {
    const s = await getCiaraVisitSyncSettings(shopId);
    if (!s.enabled) return;
    await runCiaraVisitSync(shopId, admin);
  })().catch((e) => console.warn("[ciara-visit-sync] open kick failed", e));
}

const scheduler = createCiaraSyncScheduler({
  tag: "ciara-visit-sync",
  queue: CIARA_VISIT_SYNC_QUEUE,
  // 5 分ごとに読む（2 分・7 分…）
  cron: "2-59/5 * * * *",
  ready: () => ciaraVisitSyncAvailable() && ciaraVisitSyncServerReady() && Boolean(process.env.DATABASE_URL?.trim()),
  work: async () => {
    const { unauthenticated } = await import("../shopify.server");
    const shops = await prisma.shop.findMany({ select: { id: true, shopDomain: true } });
    for (const shop of shops) {
      try {
        const s = await getCiaraVisitSyncSettings(shop.id);
        if (!s.enabled) continue;
        const { admin } = await unauthenticated.admin(shop.shopDomain);
        const result = await runCiaraVisitSync(shop.id, admin);
        console.log(`[ciara-visit-sync] shop=${shop.shopDomain} ok=${result.ok} ${result?.message}`);
      } catch (e) {
        console.error(`[ciara-visit-sync] shop=${shop.shopDomain} failed`, e);
      }
    }
  },
});

/** 定期の仕事を始める（自社用で、サーバーの準備ができているときだけ。始まらなければ記録に出し、あとでもう一度始める） */
export function ensureCiaraVisitSyncScheduler() {
  return scheduler.ensure();
}

/** 定期の仕事の今の状態（管理画面の「つながり」に出す） */
export function ciaraVisitSyncSchedulerStatus(): CiaraSchedulerStatus {
  return scheduler.status();
}
