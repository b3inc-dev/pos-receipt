import {
  isThrottledError,
  SETTLEMENT_THROTTLED_USER_MESSAGE,
  ThrottledExhaustedError,
} from "../lib/shopifyGraphqlThrottle.server";
import { UpstreamAggregationError } from "../services/settlementUpstreamPage.server";
import { corsErrorJson } from "./posAuth.server";

/**
 * 精算 API のエラーレスポンス（Throttled は 503 + 日本語）
 */
export function settlementApiErrorResponse(
  request: Request,
  err: unknown,
): Response {
  if (err instanceof ThrottledExhaustedError || isThrottledError(err)) {
    return corsErrorJson(
      request,
      { ok: false, error: SETTLEMENT_THROTTLED_USER_MESSAGE, code: "THROTTLED" },
      503,
    );
  }
  if (err instanceof UpstreamAggregationError) {
    return corsErrorJson(
      request,
      { ok: false, error: err.message, code: err.code },
      500,
    );
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  return corsErrorJson(request, { ok: false, error: message }, 500);
}
