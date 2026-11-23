/**
 * 入店数を ciara-system とそろえる（Ciara のカスタムアプリだけ。T 2026-11-24「どちらからでも報告でき、どちらにも最新の値が出る」）。
 *
 * - 自社用（APP_DISTRIBUTION=inhouse）でないときは何もしない。公開アプリでは設定も画面も出さない
 * - 鍵は予算の取り込みと同じ環境変数 CIARA_BUDGET_SYNC_SECRET（ciara-system の POS_RECEIPT_BUDGET_SECRET と同じ値）
 * - 管理画面で「そろえる」をオンにしたショップだけ動く
 * - 10 分ごとに、今日を含めた前の 35 日を ciara-system と比べ、店 × 日ごとにあとから入れたほうへ合わせる
 * - POS で入店数を報告したときは、その 1 日ぶんをすぐ ciara-system へ送る（失敗しても次の 10 分ごとの回で送り直す）
 * - ciara-system へ書くのは ciara-system のマスタで受け取りがオンのときだけ（既定オフ）。オフなら読むだけ
 */
import PgBoss from "pg-boss";
import prisma from "../db.server";
import { getAppSetting, setAppSetting } from "../utils/appSettings.server";
import { isInhouseMode } from "../utils/planFeatures.server";
import { getCalendarDateStringInTimeZone, getShopTimezoneForDaily } from "../utils/shopTimezone.server";
import {
  CIARA_VISIT_SYNC_KEY,
  DEFAULT_CIARA_VISIT_SYNC,
  numericLocationId,
  parseCiaraVisitResponse,
  planVisitSync,
  splitVisitKey,
  visitKey,
  visitSyncDateRange,
  type CiaraVisitSyncLastRun,
  type CiaraVisitSyncSettings,
  type LocalVisit,
  type RemoteVisit,
} from "../utils/ciaraVisitSync";
import { ciaraBudgetSyncSecret } from "./ciaraBudgetSync.server";
import { writeFootfallVisitors } from "./footfallWrite.server";

export const CIARA_VISIT_SYNC_QUEUE = "pos-receipt-ciara-visit-sync";
const FETCH_TIMEOUT_MS = 20_000;

type AdminClient = { graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }> };

export function ciaraVisitSyncAvailable(): boolean {
  return isInhouseMode();
}

export async function getCiaraVisitSyncSettings(shopId: string): Promise<CiaraVisitSyncSettings> {
  const saved = await getAppSetting<Partial<CiaraVisitSyncSettings>>(shopId, CIARA_VISIT_SYNC_KEY);
  return { ...DEFAULT_CIARA_VISIT_SYNC, ...saved };
}

export async function saveCiaraVisitSyncSettings(shopId: string, settings: CiaraVisitSyncSettings) {
  await setAppSetting(shopId, CIARA_VISIT_SYNC_KEY, settings);
}

function isAllowedEndpoint(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

type PostResult = {
  shopifyLocationId: string;
  date: string;
  outcome: "applied" | "same" | "kept_newer" | "unknown_store" | "not_eligible";
  visitCount: number | null;
  updatedAt: string | null;
};

/** POS の数を ciara-system に送る。返事の形が違えば null */
async function postVisits(
  endpointUrl: string,
  secret: string,
  visits: { shopifyLocationId: string; date: string; visitCount: number; enteredAt: string }[],
): Promise<{ ok: true; results: PostResult[] } | { ok: false; status: number | null; message: string }> {
  try {
    const res = await fetch(endpointUrl, {
      method: "POST",
      headers: { "X-Cron-Secret": secret, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ visits }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 403) return { ok: false, status: 403, message: "ciara-system で受け取りがオフです" };
    if (!res.ok) return { ok: false, status: res.status, message: `ciara-system が失敗を返しました（${res.status}）` };
    const json = (await res.json()) as { ok?: unknown; results?: unknown };
    if (json?.ok !== true || !Array.isArray(json.results)) {
      return { ok: false, status: res.status, message: "ciara-system の返事の形が違います" };
    }
    return { ok: true, results: json.results as PostResult[] };
  } catch (e) {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    return { ok: false, status: null, message: timeout ? "ciara-system の返事が遅く、途中でやめました" : "ciara-system につながりませんでした" };
  }
}

/**
 * POS で入店数を報告した直後に、その 1 日ぶんを ciara-system へ送る（待たせないよう呼ぶ側は await しない）。
 * ciara-system のほうが新しければ、その数をこのアプリに入れる。失敗しても次の定期の回で送り直す。
 */
export async function pushFootfallToCiara(shopId: string, locationGid: string, date: string): Promise<void> {
  if (!ciaraVisitSyncAvailable()) return;
  const secret = ciaraBudgetSyncSecret();
  if (!secret) return;
  const settings = await getCiaraVisitSyncSettings(shopId);
  if (!settings.enabled || !isAllowedEndpoint(settings.endpointUrl)) return;
  const row = await prisma.footfallReport.findUnique({
    where: { shopId_locationId_targetDate: { shopId, locationId: locationGid, targetDate: date } },
  });
  if (!row || row.source !== "pos") return;
  const res = await postVisits(settings.endpointUrl, secret, [
    { shopifyLocationId: numericLocationId(locationGid), date, visitCount: row.visitors, enteredAt: row.enteredAt.toISOString() },
  ]);
  if (!res.ok) return;
  await applyPostResults(shopId, res.results, new Map([[visitKey(locationGid, date), row.enteredAt.toISOString()]]));
}

/** 送った結果を DB に入れる（送り終えた印・ciara-system のほうが新しかった数）。数を返す */
async function applyPostResults(
  shopId: string,
  results: PostResult[],
  sentEnteredAt: Map<string, string>,
): Promise<{ pushed: number; pulled: number; skipped: string[] }> {
  let pushed = 0;
  let pulled = 0;
  const skipped: string[] = [];
  const now = new Date();
  for (const r of results) {
    const gid = `gid://shopify/Location/${r.shopifyLocationId}`;
    const key = visitKey(gid, r.date);
    const sentAt = sentEnteredAt.get(key);
    if (!sentAt) continue;
    if (r.outcome === "applied" || r.outcome === "same") {
      // 送ったあとに POS でまた直されていたら印を付けない（次の回で送る）
      const done = await prisma.footfallReport.updateMany({
        where: { shopId, locationId: gid, targetDate: r.date, source: "pos", enteredAt: new Date(sentAt) },
        data: { pushedAt: now },
      });
      if (r.outcome === "applied" && done.count > 0) pushed++;
    } else if (r.outcome === "kept_newer" && typeof r.visitCount === "number" && r.updatedAt) {
      await writeFootfallVisitors(prisma, {
        shopId,
        locationGid: gid,
        date: r.date,
        visitors: r.visitCount,
        source: "ciara",
        enteredAt: new Date(r.updatedAt),
        onlyIfEnteredBefore: new Date(r.updatedAt),
      });
      pulled++;
    } else if (r.outcome === "unknown_store" || r.outcome === "not_eligible") {
      if (!skipped.includes(r.shopifyLocationId)) skipped.push(r.shopifyLocationId);
    }
  }
  return { pushed, pulled, skipped };
}

const LOCATIONS_QUERY = `#graphql
  query Locations {
    locations(first: 250, includeLegacy: false) {
      nodes { id name }
    }
  }
`;

/** 1 回そろえる。結果は設定の lastRun に残す */
export async function runCiaraVisitSync(shopId: string, admin: AdminClient): Promise<CiaraVisitSyncLastRun> {
  const settings = await getCiaraVisitSyncSettings(shopId);
  const base: CiaraVisitSyncLastRun = {
    at: new Date().toISOString(),
    ok: false,
    message: "",
    pulled: 0,
    pushed: 0,
    receiveOff: false,
    unmatched: [],
    skipped: [],
  };
  const finish = async (lastRun: CiaraVisitSyncLastRun) => {
    const latest = await getCiaraVisitSyncSettings(shopId);
    await saveCiaraVisitSyncSettings(shopId, { ...latest, lastRun });
    return lastRun;
  };

  if (!ciaraVisitSyncAvailable()) return finish({ ...base, message: "このアプリでは使えません" });
  if (!settings.enabled) return finish({ ...base, message: "そろえる設定がオフです" });
  const secret = ciaraBudgetSyncSecret();
  if (!secret) return finish({ ...base, message: "サーバーの準備がまだです" });
  if (!isAllowedEndpoint(settings.endpointUrl)) {
    return finish({ ...base, message: "ciara-system の URL が正しくありません（https:// で始まる URL）" });
  }

  const timezone = await getShopTimezoneForDaily(admin, shopId);
  const dates = visitSyncDateRange(getCalendarDateStringInTimeZone(new Date(), timezone));
  const url = new URL(settings.endpointUrl);
  url.searchParams.set("from", dates[0]);
  url.searchParams.set("to", dates[dates.length - 1]);

  let json: unknown;
  try {
    const res = await fetch(url, {
      headers: { "X-Cron-Secret": secret, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401) return finish({ ...base, message: "ciara-system につなげませんでした（合言葉が合いません）" });
    if (res.status === 404) return finish({ ...base, message: "ciara-system の入店数の口が止まっているか、URL が違います" });
    if (!res.ok) return finish({ ...base, message: `ciara-system が失敗を返しました（${res.status}）` });
    json = await res.json();
  } catch (e) {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    return finish({ ...base, message: timeout ? "ciara-system の返事が遅く、途中でやめました" : "ciara-system につながりませんでした" });
  }
  const parsed = parseCiaraVisitResponse(json, dates);
  if (!parsed.ok) return finish({ ...base, message: parsed.error });

  let locations: { id: string; name: string }[] = [];
  try {
    const locRes = await admin.graphql(LOCATIONS_QUERY);
    const locJson = (await locRes.json()) as { data?: { locations?: { nodes?: { id: string; name: string }[] } } };
    locations = locJson.data?.locations?.nodes ?? [];
  } catch {
    return finish({ ...base, message: "Shopify のロケーションを読めませんでした" });
  }
  const shopLocationIds = new Set(locations.map((l) => l.id));
  const locationName = new Map(locations.map((l) => [numericLocationId(l.id), l.name]));

  const remote = new Map<string, RemoteVisit>();
  const unmatched: string[] = [];
  for (const s of parsed.stores) {
    const gid = `gid://shopify/Location/${s.shopifyLocationId}`;
    if (!shopLocationIds.has(gid)) {
      if (s.days.length > 0) unmatched.push(s.storeName);
      continue;
    }
    for (const d of s.days) remote.set(visitKey(gid, d.date), { visitCount: d.visitCount, updatedAt: d.updatedAt });
  }

  const localRows = await prisma.footfallReport.findMany({
    where: { shopId, locationId: { in: [...shopLocationIds] }, targetDate: { gte: dates[0], lte: dates[dates.length - 1] } },
    select: { locationId: true, targetDate: true, visitors: true, enteredAt: true, source: true, pushedAt: true },
  });
  const local = new Map<string, LocalVisit>(
    localRows.map((r) => [
      visitKey(r.locationId, r.targetDate),
      { visitors: r.visitors, enteredAt: r.enteredAt.toISOString(), source: r.source, pushedAt: r.pushedAt?.toISOString() ?? null },
    ]),
  );

  const plan = planVisitSync(local, remote);
  let pulled = 0;

  // ciara-system の数をこのアプリへ（POS で同じ時刻より後に直していたら書かない）
  for (const item of plan.toLocal) {
    const { locationGid, date } = splitVisitKey(item.key);
    const wrote = await writeFootfallVisitors(prisma, {
      shopId,
      locationGid,
      date,
      visitors: item.visitCount,
      source: "ciara",
      enteredAt: new Date(item.updatedAt),
      onlyIfEnteredBefore: new Date(item.updatedAt),
    });
    if (wrote) pulled++;
  }
  if (plan.markPushed.length > 0) {
    const now = new Date();
    for (const key of plan.markPushed) {
      const { locationGid, date } = splitVisitKey(key);
      await prisma.footfallReport.updateMany({
        where: { shopId, locationId: locationGid, targetDate: date, source: "pos", pushedAt: null },
        data: { pushedAt: now },
      });
    }
  }

  // POS の数を ciara-system へ（ciara-system の受け取りがオフなら送らない）
  let pushed = 0;
  const skipped: string[] = [];
  let pushMessage = "";
  const receiveOff = plan.toRemote.length > 0 && !parsed.receiveEnabled;
  if (plan.toRemote.length > 0 && parsed.receiveEnabled) {
    const sent = new Map(plan.toRemote.map((v) => [v.key, v.enteredAt]));
    const res = await postVisits(
      settings.endpointUrl,
      secret,
      plan.toRemote.map((v) => {
        const { locationGid, date } = splitVisitKey(v.key);
        return { shopifyLocationId: numericLocationId(locationGid), date, visitCount: v.visitCount, enteredAt: v.enteredAt };
      }),
    );
    if (res.ok) {
      const applied = await applyPostResults(shopId, res.results, sent);
      pushed = applied.pushed;
      pulled += applied.pulled;
      for (const id of applied.skipped) skipped.push(locationName.get(id) ?? id);
    } else {
      pushMessage = res.message;
    }
  }

  const parts: string[] = [];
  if (pulled > 0) parts.push(`ciara-system の入店数を ${pulled} 日ぶん入れました`);
  if (pushed > 0) parts.push(`POS の入店数を ${pushed} 日ぶん ciara-system に送りました`);
  if (receiveOff) parts.push(`ciara-system で受け取りがオフなので、POS の入店数 ${plan.toRemote.length} 日ぶんは送っていません`);
  if (pushMessage) parts.push(`POS の入店数を送れませんでした（${pushMessage}）`);
  if (parts.length === 0) parts.push("変わった入店数はありませんでした");

  return finish({
    at: new Date().toISOString(),
    ok: !pushMessage,
    message: parts.join("。"),
    pulled,
    pushed,
    receiveOff,
    unmatched,
    skipped,
  });
}

let startPromise: Promise<PgBoss | null> | null = null;

/** 10 分ごとにそろえる（自社用で、鍵があるときだけ。1 プロセス 1 回） */
export function ensureCiaraVisitSyncScheduler(): Promise<PgBoss | null> {
  if (!ciaraVisitSyncAvailable() || !ciaraBudgetSyncSecret() || !process.env.DATABASE_URL?.trim()) {
    return Promise.resolve(null);
  }
  if (!startPromise) {
    startPromise = (async () => {
      const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, application_name: "pos-receipt-ciara-visit-sync" });
      boss.on("error", (err: Error) => console.error("[ciara-visit-sync]", err));
      await boss.start();
      await boss.createQueue(CIARA_VISIT_SYNC_QUEUE, { name: CIARA_VISIT_SYNC_QUEUE, retryLimit: 0 }).catch(() => {});
      // 10 分ごと（3 分・13 分…）。pg-boss の schedule は複数のサーバーでも 1 回だけ動く
      await boss.schedule(CIARA_VISIT_SYNC_QUEUE, "3-59/10 * * * *", {}, { tz: "Asia/Tokyo" });
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
