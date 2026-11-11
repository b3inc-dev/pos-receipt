/**
 * 精算・売上サマリーが共有する注文ページの完全性チェック。
 * 上流の内部エラーやタイムアウトで data が欠けても、空配列や途中ページを成功として返さない。
 */

export const UPSTREAM_AGGREGATION_FAILURE_MESSAGE =
  "売上データの取得が完了しなかったため、集計は確定していません。しばらくしてから再試行してください。";

export class UpstreamAggregationError extends Error {
  readonly code = "UPSTREAM_INCOMPLETE";

  constructor() {
    super(UPSTREAM_AGGREGATION_FAILURE_MESSAGE);
    this.name = "UpstreamAggregationError";
  }
}

type GraphqlErrorShape = {
  message?: string;
  extensions?: { code?: string };
};

export type OrdersConnectionPage = {
  nodes: unknown[];
  hasNextPage: boolean;
  endCursor: string | null;
};

function reject(context: string, reason: string): never {
  console.warn("[settlement-upstream]", context, "reject", reason);
  throw new UpstreamAggregationError();
}

function readGraphqlErrors(json: unknown): GraphqlErrorShape[] | null {
  if (!json || typeof json !== "object") return null;
  const errors = (json as { errors?: unknown }).errors;
  if (errors == null) return [];
  if (!Array.isArray(errors)) return null;
  return errors as GraphqlErrorShape[];
}

/**
 * orders 接続の 1 ページを読む。
 * GraphQL errors、orders 欠落、pageInfo 欠落、次ページなのに cursor がない場合は throw する。
 * 呼び出し側は throw 時にそれまで積んだ注文を確定してはならない。
 */
export function readOrdersPageOrThrow(json: unknown, context: string): OrdersConnectionPage {
  const errors = readGraphqlErrors(json);
  if (!json || typeof json !== "object" || errors == null) {
    return reject(context, "invalid-payload");
  }
  if (errors.length > 0) {
    const codes = errors
      .map((e) => String(e.extensions?.code ?? "").trim())
      .filter(Boolean)
      .slice(0, 5);
    return reject(context, codes.join(",") || "graphql-error");
  }

  const orders = (json as { data?: { orders?: unknown } }).data?.orders;
  if (!orders || typeof orders !== "object") {
    return reject(context, "missing-orders");
  }

  const pageInfo = (orders as { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } }).pageInfo;
  if (!pageInfo || typeof pageInfo.hasNextPage !== "boolean") {
    return reject(context, "missing-page-info");
  }
  if (pageInfo.hasNextPage && (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor.length === 0)) {
    return reject(context, "missing-cursor");
  }

  const nodes = (orders as { nodes?: unknown }).nodes;
  if (nodes != null && !Array.isArray(nodes)) {
    return reject(context, "invalid-nodes");
  }

  return {
    nodes: nodes ?? [],
    hasNextPage: pageInfo.hasNextPage,
    endCursor: typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null,
  };
}
