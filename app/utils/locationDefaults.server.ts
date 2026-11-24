/**
 * 店舗の画面（一覧・全店の決まり・まとめて変更・店ごとの編集）の読み書き。
 * 精算・売上サマリーが読む Location の列は今までどおりで、ここはその列を書くだけ（読む側は変えない）。
 */
import prisma from "../db.server";
import { getAppSetting, setAppSetting } from "./appSettings.server";
import {
  DEFAULTABLE_KEYS,
  LOCATION_DEFAULTS_KEY,
  SCHEMA_DEFAULTS,
  inferDefaults,
  newLocationIds,
  readStoredDefaults,
  type DefaultableKey,
  type LocationDefaults,
  type LocationUpdate,
  type LocationValues,
  type StoredLocationDefaults,
} from "./locationDefaults";

type AdminClient = { graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }> };

const LOCATIONS_QUERY = `#graphql
  query StoreLocations($after: String) {
    locations(first: 250, after: $after, includeLegacy: false) {
      nodes { id name isActive }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export type StoreLocation = LocationValues & {
  name: string;
  displayName: string | null;
  shortName: string | null;
  sortOrder: number;
  printMode: string;
  cloudprntEnabled: boolean;
  printerProfileId: string | null;
  summaryTargetGroup: string | null;
  nonPosRefundAttributionEnabled: boolean;
};

/** Shopify の使っている店（稼働中のロケーション）と、DB の店の設定を合わせる。DB に無い店は列の初期値で見せる */
export async function loadStoreLocations(admin: AdminClient, shopId: string): Promise<StoreLocation[]> {
  const shopify: { id: string; name: string }[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const res = await admin.graphql(LOCATIONS_QUERY, { variables: { after } });
    const json = (await res.json()) as {
      data?: { locations?: { nodes?: { id: string; name: string; isActive: boolean }[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } };
    };
    for (const node of json.data?.locations?.nodes ?? []) if (node.isActive) shopify.push({ id: node.id, name: node.name });
    const info = json.data?.locations?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  const rows = await prisma.location.findMany({ where: { shopId } });
  const byGid = new Map(rows.map((row) => [row.shopifyLocationGid, row]));
  const list = shopify.map((sl): StoreLocation => {
    const db = byGid.get(sl.id);
    const values = {} as LocationDefaults;
    for (const key of DEFAULTABLE_KEYS) values[key] = db ? Boolean(db[key]) : SCHEMA_DEFAULTS[key];
    return {
      id: sl.id,
      name: sl.name,
      displayName: db?.displayName ?? null,
      shortName: db?.shortName ?? null,
      sortOrder: db?.sortOrder ?? 0,
      printMode: db?.printMode ?? "order_based",
      cloudprntEnabled: db?.cloudprntEnabled ?? false,
      printerProfileId: db?.printerProfileId ?? null,
      summaryTargetGroup: db?.summaryTargetGroup ?? null,
      nonPosRefundAttributionEnabled: db?.nonPosRefundAttributionEnabled ?? false,
      ...values,
    };
  });
  list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ja"));
  return list;
}

export async function getStoredDefaults(shopId: string): Promise<StoredLocationDefaults | null> {
  return readStoredDefaults(await getAppSetting(shopId, LOCATION_DEFAULTS_KEY));
}

/** 今の決まり（保存済みならそれ、無ければ今いちばん多い値）と、保存済みかどうか */
export function currentDefaults(locations: LocationValues[], stored: StoredLocationDefaults | null): { defaults: LocationDefaults; saved: boolean } {
  return stored ? { defaults: stored.defaults, saved: true } : { defaults: inferDefaults(locations), saved: false };
}

/** 店の列を書く（DB に行が無い店は作る）。1 つのトランザクションで */
export async function writeLocationUpdates(shopId: string, locations: StoreLocation[], updates: LocationUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  const names = new Map(locations.map((loc) => [loc.id, loc.name]));
  await prisma.$transaction(
    updates.map((update) =>
      prisma.location.upsert({
        where: { shopId_shopifyLocationGid: { shopId, shopifyLocationGid: update.id } },
        update: update.data,
        create: { shopId, shopifyLocationGid: update.id, name: names.get(update.id) ?? "", ...update.data },
      }),
    ),
  );
  // 売上サマリーをオンにした店は、当月分を裏で数え始める（POS で初めて開いたときに待たせない）
  const before = new Map(locations.map((loc) => [loc.id, loc.salesSummaryEnabled]));
  const turnedOn = updates
    .filter((u) => u.data.salesSummaryEnabled === true && before.get(u.id) !== true)
    .map((u) => ({ shopifyLocationGid: u.id, name: names.get(u.id) ?? "" }));
  if (turnedOn.length > 0) {
    const { enqueueSalesSummaryFillForTurnedOn } = await import("../services/salesSummaryFillQueue.server");
    void enqueueSalesSummaryFillForTurnedOn(shopId, turnedOn);
  }
}

export async function saveStoredDefaults(shopId: string, defaults: LocationDefaults, locationIds: string[]): Promise<void> {
  const value: StoredLocationDefaults = { defaults, appliedLocationIds: locationIds, savedAt: new Date().toISOString() };
  await setAppSetting(shopId, LOCATION_DEFAULTS_KEY, value);
}

/**
 * 決まりを保存したあとで Shopify に足された店に、決まりを当てる（店の一覧を開いたときに 1 回だけ）。
 * まだ決まりを保存していない店では何もしない。
 */
export async function applyDefaultsToNewLocations(
  shopId: string,
  locations: StoreLocation[],
  stored: StoredLocationDefaults | null,
  lockedKeys: DefaultableKey[],
): Promise<StoreLocation[]> {
  const fresh = newLocationIds(locations.map((loc) => loc.id), stored);
  if (!stored || fresh.length === 0) return locations;
  const updates: LocationUpdate[] = fresh.map((id) => {
    const data: Partial<LocationDefaults> = {};
    for (const key of DEFAULTABLE_KEYS) if (!lockedKeys.includes(key)) data[key] = stored.defaults[key];
    return { id, data };
  });
  await writeLocationUpdates(shopId, locations, updates);
  await saveStoredDefaults(shopId, stored.defaults, [...new Set([...stored.appliedLocationIds, ...fresh])]);
  const byId = new Map(updates.map((u) => [u.id, u.data]));
  return locations.map((loc) => (byId.has(loc.id) ? { ...loc, ...byId.get(loc.id) } : loc));
}

/** 決まりを当てた店として残す一覧（今の Shopify の店＋DB にある店。止めている店も、あとから足された店と間違えないように入れる） */
export async function knownLocationIds(shopId: string, locations: StoreLocation[]): Promise<string[]> {
  const rows = await prisma.location.findMany({ where: { shopId }, select: { shopifyLocationGid: true } });
  return [...new Set([...locations.map((loc) => loc.id), ...rows.map((row) => row.shopifyLocationGid)])];
}

/** プランで使えない項目（売上サマリーはプロプランから。自社用・開発ストアは全部使える） */
export function lockedKeysForPlan(fullAccess: boolean, planCode: string | null | undefined): DefaultableKey[] {
  const isPro = fullAccess || planCode === "pro" || planCode === "unlimited";
  return isPro ? [] : ["salesSummaryEnabled"];
}
