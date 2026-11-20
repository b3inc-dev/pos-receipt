/**
 * 会員証の全件スキャンで `metafields.<namespace>.<key>:*` の絞り込みが効くかを、項目ごとに確かめる。
 *
 * Shopify は、定義が無い・定義の絞り込み（adminFilterable）がオフのメタフィールドで絞ると、
 * 2026-07 までの API ではその条件を黙って無視してすべての顧客を返し、2026-10 からはエラーを返す
 * （changelog「Invalid metafield queries now return errors in the GraphQL Admin API」）。
 * そのため、定義があり `capabilities.adminFilterable` が enabled かつ status が FILTERABLE のときだけ「使える」とする
 * （MetafieldCapabilityAdminFilterable / MetafieldDefinitionAdminFilterStatus）。
 *
 * 結果は店ごと・項目ごとに少しのあいだ覚えておく（定義を読めなかったときは覚えない）。
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { fieldLabel, type LineIdField } from "../utils/memberCardLineFields";

export const FIELD_FILTER_CACHE_TTL_MS = 5 * 60 * 1000;

const DEFINITION_QUERY = `#graphql
  query memberCardLineFieldDefinition($namespace: String!, $key: String!) {
    metafieldDefinitions(first: 1, ownerType: CUSTOMER, namespace: $namespace, key: $key) {
      nodes {
        namespace
        key
        capabilities {
          adminFilterable {
            enabled
            status
          }
        }
      }
    }
  }
`;

type DefinitionJson = {
  data?: {
    metafieldDefinitions?: {
      nodes?: Array<{
        namespace?: string;
        key?: string;
        capabilities?: { adminFilterable?: { enabled?: boolean; status?: string } | null } | null;
      }>;
    };
  };
  errors?: unknown[];
};

export type FieldFilterState = "usable" | "no_definition" | "not_filterable" | "unknown";

const cache = new Map<string, { state: Exclude<FieldFilterState, "unknown">; at: number }>();

function cacheKey(shop: string, field: LineIdField): string {
  return `${shop}\n${fieldLabel(field)}`;
}

/** テスト用。覚えた結果を消す。 */
export function clearFieldFilterCache(): void {
  cache.clear();
}

/** 全件スキャンで絞り込みが効かなかったと分かったときに、覚えた結果を「使えない」に変える。 */
export function markFieldNotFilterable(shop: string | undefined, field: LineIdField, now: number = Date.now()): void {
  if (!shop) return;
  cache.set(cacheKey(shop, field), { state: "not_filterable", at: now });
}

/**
 * その項目の定義で絞り込みが効くか。"usable" のときだけ全件スキャンしてよい。
 * 定義を読めなかった（エラー・例外）ときは "unknown"（この回はその項目を見ない。覚えない）。
 */
export async function lineFieldFilterState(
  admin: Pick<AdminApiContext, "graphql">,
  shop: string | undefined,
  field: LineIdField,
  now: number = Date.now()
): Promise<FieldFilterState> {
  const key = shop ? cacheKey(shop, field) : null;
  if (key) {
    const hit = cache.get(key);
    if (hit && now - hit.at < FIELD_FILTER_CACHE_TTL_MS) return hit.state;
  }
  let json: DefinitionJson;
  try {
    const res = await admin.graphql(DEFINITION_QUERY, { variables: { namespace: field.namespace, key: field.key } });
    json = (await res.json()) as DefinitionJson;
  } catch (err) {
    console.warn("[member-card] metafieldDefinitions failed:", fieldLabel(field), err instanceof Error ? err.message : err);
    return "unknown";
  }
  if (json.errors?.length) {
    console.warn("[member-card] metafieldDefinitions errors:", fieldLabel(field), json.errors);
    return "unknown";
  }
  const node = (json.data?.metafieldDefinitions?.nodes ?? []).find(
    (n) => n?.namespace === field.namespace && n?.key === field.key
  );
  const filterable = node?.capabilities?.adminFilterable;
  const state: Exclude<FieldFilterState, "unknown"> = !node
    ? "no_definition"
    : filterable?.enabled === true && filterable?.status === "FILTERABLE"
      ? "usable"
      : "not_filterable";
  if (key) cache.set(key, { state, at: now });
  return state;
}
