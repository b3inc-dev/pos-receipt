/**
 * 入店数を ciara-system と見せ合う（Ciara のカスタムアプリだけ。T 2026-11-24「どの店も両方使えて、どちらも報告があった時点で反映」）。
 *
 * どちらも「読みにいくだけ」で、相手に書かない。
 * - ciara-system → このアプリ: 5 分ごとと、POS で売上サマリーを開いたとき（1 分に 1 回まで・待たせない）に、
 *   ciara-system の読む口から今日を含めた前の 35 日の入店数を読み、人があとから入れた数ならこのアプリの入店数に入れる
 * - このアプリ → ciara-system: ciara-system が /api/external/ciara/footfall を読みにくる（POS で入れた数だけを渡す）
 *
 * - 自社用（APP_DISTRIBUTION=inhouse）でないときは何もしない。公開アプリでは設定も画面も出さない
 * - 合言葉は予算と同じ CIARA_BUDGET_SYNC_SECRET、読む先は CIARA_SYSTEM_ORIGIN（管理画面からは変えられない）
 * - 管理画面で「見せ合う」をオンにしたショップだけ動く（既定オフ）
 */
import PgBoss from "pg-boss";
import prisma from "../db.server";
import { getAppSetting, setAppSetting } from "../utils/appSettings.server";
import { isInhouseMode } from "../utils/planFeatures.server";
import { getCalendarDateStringInTimeZone, getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import {
  CIARA_VISIT_SYNC_KEY,
  DEFAULT_CIARA_VISIT_SYNC,
  parseCiaraVisitResponse,
  planVisitPull,
  splitVisitKey,
  visitKey,
  visitSyncDateRange,
  type CiaraVisitSyncLastRun,
  type CiaraVisitSyncSettings,
  type LocalVisit,
  type RemoteVisit,
} from "../utils/ciaraVisitSync";
import { ciaraBudgetSyncSecret } from "./ciaraBudgetSync.server";
import { CIARA_VISITS_PATH, ciaraSystemUrl } from "./ciaraSystemOrigin.server";
import { writeCiaraFootfall } from "./footfallWrite.server";

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
  const base: CiaraVisitSyncLastRun = { at: new Date().toISOString(), ok: false, message: "", pulled: 0, unmatched: [] };
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
  const unmatched: string[] = [];
  for (const s of parsed.stores) {
    const gid = `gid://shopify/Location/${s.shopifyLocationId}`;
    if (!shopLocationIds.has(gid)) {
      if (s.days.length > 0) unmatched.push(s.storeName);
      continue;
    }
    for (const d of s.days) remote.set(visitKey(gid, d.date), { visitCount: d.visitCount, reportedAt: d.reportedAt });
  }

  const localRows = await prisma.footfallReport.findMany({
    where: { shopId, locationId: { in: [...shopLocationIds] }, targetDate: { gte: dates[0], lte: dates[dates.length - 1] } },
    select: { locationId: true, targetDate: true, visitors: true, enteredAt: true, source: true },
  });
  const local = new Map<string, LocalVisit>(
    localRows.map((r) => [visitKey(r.locationId, r.targetDate), { visitors: r.visitors, enteredAt: r.enteredAt.toISOString(), source: r.source }]),
  );

  let pulled = 0;
  for (const item of planVisitPull(local, remote)) {
    const { locationGid, date } = splitVisitKey(item.key);
    // 確かめと書き込みは 1 つの文（読んだあとに POS で報告されていたら書かない）
    const wrote = await writeCiaraFootfall(prisma, {
      shopId,
      locationGid,
      date,
      visitors: item.visitCount,
      enteredAt: new Date(item.enteredAt),
    });
    if (wrote) pulled++;
  }

  return finish({
    at: new Date().toISOString(),
    ok: true,
    message: pulled > 0 ? `ciara-system で入れた入店数を ${pulled} 日ぶん入れました` : "変わった入店数はありませんでした",
    pulled,
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

let startPromise: Promise<PgBoss | null> | null = null;

/** 5 分ごとに読む（自社用で、サーバーの準備ができているときだけ。1 プロセス 1 回） */
export function ensureCiaraVisitSyncScheduler(): Promise<PgBoss | null> {
  if (!ciaraVisitSyncAvailable() || !ciaraVisitSyncServerReady() || !process.env.DATABASE_URL?.trim()) {
    return Promise.resolve(null);
  }
  if (!startPromise) {
    startPromise = (async () => {
      const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, application_name: "pos-receipt-ciara-visit-sync" });
      boss.on("error", (err: Error) => console.error("[ciara-visit-sync]", err));
      await boss.start();
      await boss.createQueue(CIARA_VISIT_SYNC_QUEUE, { name: CIARA_VISIT_SYNC_QUEUE, retryLimit: 0 }).catch(() => {});
      // 5 分ごと（2 分・7 分…）。pg-boss の schedule は複数のサーバーでも 1 回だけ動く
      await boss.schedule(CIARA_VISIT_SYNC_QUEUE, "2-59/5 * * * *", {}, { tz: "Asia/Tokyo" });
      await boss.work(CIARA_VISIT_SYNC_QUEUE, async () => {
        const { unauthenticated } = await import("../shopify.server");
        const shops = await prisma.shop.findMany({ select: { id: true, shopDomain: true } });
        for (const shop of shops) {
          try {
            const s = await getCiaraVisitSyncSettings(shop.id);
            if (!s.enabled) continue;
            const { admin } = await unauthenticated.admin(shop.shopDomain);
            const result = await runCiaraVisitSync(shop.id, admin);
            console.log(`[ciara-visit-sync] shop=${shop.shopDomain} ok=${result.ok} ${result.message}`);
          } catch (e) {
            console.error(`[ciara-visit-sync] shop=${shop.shopDomain} failed`, e);
          }
        }
      });
      const stop = () => void boss.stop({ timeout: 20000 }).catch(() => {});
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      return boss;
    })().catch((e) => {
      console.error("[ciara-visit-sync] start failed:", e);
      return null;
    });
  }
  return startPromise;
}
