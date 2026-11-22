/**
 * 開発ストアかどうか（Shopify の shop.plan.partnerDevelopment）
 *
 * T さんの決定（2026-11-22）: 一般設定の「デバッグモード」「診断パネル」「詳細計算ログ」の欄は
 * 開発ストアだけに出し、客先の店には出さない。
 *
 * - 店の名前はコードに書かない。Shopify が返す partnerDevelopment だけで決める
 *   （line-crm #44・Shop Point と同じ読み方）。
 * - 自社用（APP_DISTRIBUTION=inhouse）や CUSTOM_APP_STORE_IDS は、本番の Ciara も入るので使わない
 *   （planFeatures.server.ts の getFullAccess とは目的が違う）。
 * - 読めない・失敗した・true でないときは「開発ストアではない」として出さない。
 */

export const DEV_STORE_PLAN_QUERY = `#graphql
  query DevStorePlan { shop { plan { partnerDevelopment } } }
`;

type AdminGraphql = { graphql: (query: string) => Promise<Response> };

/** 開発ストアのときだけ true。失敗・読めないときは false。 */
export async function isDevelopmentStore(admin: AdminGraphql): Promise<boolean> {
  try {
    const res = await admin.graphql(DEV_STORE_PLAN_QUERY);
    const json = (await res.json()) as {
      data?: { shop?: { plan?: { partnerDevelopment?: unknown } | null } | null } | null;
    };
    return json?.data?.shop?.plan?.partnerDevelopment === true;
  } catch {
    return false;
  }
}

/** 開発ストアだけに出す一般設定の欄 */
export const DEV_ONLY_GENERAL_SETTING_KEYS = [
  "debugModeEnabled",
  "diagnosticsPanelEnabled",
  "verboseCalcLogEnabled",
] as const;

export type DevOnlyGeneralSettingKey = (typeof DEV_ONLY_GENERAL_SETTING_KEYS)[number];

/**
 * 開発ストアでない店から保存が来たときは、開発ストアだけの欄を保存済みの値のままにする
 * （画面に出していない欄を、送られてきた値で書きかえない）。
 */
export function keepDevOnlySettings<T extends Record<DevOnlyGeneralSettingKey, boolean>>(
  next: T,
  saved: T,
  isDevStore: boolean
): T {
  if (isDevStore) return next;
  const result = { ...next };
  for (const key of DEV_ONLY_GENERAL_SETTING_KEYS) {
    result[key] = saved[key];
  }
  return result;
}
