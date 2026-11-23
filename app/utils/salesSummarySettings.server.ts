/**
 * 売上サマリー設定の画面（一覧と区分ごとの編集）で共通に読むもの。
 * 設定の正本は AppSetting の sales_summary_settings（読む側は変えない）。
 */
import prisma from "../db.server";
import { resolveShop } from "./shopResolver.server";
import {
  getAppSetting,
  mergeAndNormalizeSalesSummarySettings,
  SALES_SUMMARY_SETTINGS_KEY,
  type SalesSummarySettings,
} from "./appSettings.server";

type Admin = { graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }> };

const LOCATIONS_QUERY = `#graphql
  query SalesSummaryLocations($after: String) {
    locations(first: 250, after: $after, includeLegacy: false) {
      nodes { id name isActive }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** 使っている店（Shopify のロケーション）。多い店でも全部読む */
export async function loadActiveLocations(admin: Admin): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const res = await admin.graphql(LOCATIONS_QUERY, { variables: { after } });
    const json = (await res.json()) as {
      data?: { locations?: { nodes?: { id: string; name: string; isActive: boolean }[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } };
    };
    for (const node of json.data?.locations?.nodes ?? []) if (node.isActive) out.push({ id: node.id, name: node.name });
    const info = json.data?.locations?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  return out;
}

export async function loadSalesSummarySettingsPage(admin: Admin, sessionShop: string) {
  const shop = await resolveShop(sessionShop, admin as never);
  const [locations, saved, shopPublic] = await Promise.all([
    loadActiveLocations(admin),
    getAppSetting<Partial<SalesSummarySettings>>(shop.id, SALES_SUMMARY_SETTINGS_KEY),
    prisma.shop.findUnique({
      where: { id: shop.id },
      select: { salesSummaryPublicTokenHash: true, salesSummaryPublicPasswordScrypt: true },
    }),
  ]);
  const settings = mergeAndNormalizeSalesSummarySettings(saved);
  if (!Array.isArray(settings.visibleLocationIds)) settings.visibleLocationIds = [];
  if (!Array.isArray(settings.footfallTargetLocationIds)) settings.footfallTargetLocationIds = [];
  return {
    shop,
    settings,
    locations,
    link: {
      active: Boolean(shopPublic?.salesSummaryPublicTokenHash),
      passwordSet: Boolean(shopPublic?.salesSummaryPublicPasswordScrypt),
    },
  };
}
