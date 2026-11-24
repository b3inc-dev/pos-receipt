import { AsyncLocalStorage } from "node:async_hooks";
import { createSettlementWorkQueue, type SettlementPriority } from "../utils/settlementWorkQueue.server";
/**
 * Shopify Admin GraphQL の Throttled 対策（リトライ・バックオフ）
 * GAS 精算スクリプトの graphqlFetch 相当。会員カード customer.server と同方針。
 */

export type AdminGraphqlClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

const MAX_THROTTLE_RETRIES = 5;
const THROTTLE_BACKOFF_MS = 2000;
/** ページング連続呼び出しの間隔（バースト抑制） */
export const GRAPHQL_PAGE_DELAY_MS = 120;

type GraphqlErrorShape = {
  message?: string;
  extensions?: { code?: string };
};

export function isThrottledError(err: unknown): boolean {
  if (err instanceof ThrottledExhaustedError) return true;
  if (err instanceof Error) {
    const msg = err.message ?? "";
    if (msg.includes("Throttled")) return true;
  }
  return false;
}

export function isThrottledGraphqlPayload(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const errors = (json as { errors?: GraphqlErrorShape[] }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => {
    const code = String(e.extensions?.code ?? "").toUpperCase();
    const msg = String(e.message ?? "");
    return code === "THROTTLED" || msg.includes("Throttled");
  });
}

export class ThrottledExhaustedError extends Error {
  constructor() {
    super("Throttled: max retries exhausted");
    this.name = "ThrottledExhaustedError";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterMs(maxJitter: number): number {
  return Math.floor(Math.random() * maxJitter);
}

/**
 * admin.graphql を実行し、Throttled 時は指数バックオフでリトライする。
 * レスポンス JSON の errors に THROTTLED が含まれる場合もリトライ対象。
 * retry.sleep は待ち方を差し替えるとき（試験用）。書かなければ本当に待つ。
 */
export async function adminGraphqlWithRetry<TJson = unknown>(
  admin: AdminGraphqlClient,
  query: string,
  options?: object,
  context?: string,
  retry: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<TJson> {
  const wait = retry.sleep ?? sleep;
  for (let attempt = 1; attempt <= MAX_THROTTLE_RETRIES; attempt++) {
    try {
      const response = await admin.graphql(query, options);
      const json = (await response.json()) as TJson;
      if (isThrottledGraphqlPayload(json)) {
        throw new Error("Throttled");
      }
      return json;
    } catch (err) {
      if (!isThrottledError(err)) throw err;
      if (attempt === MAX_THROTTLE_RETRIES) {
        console.warn(
          "[shopify-graphql]",
          context ?? "query",
          "Throttled after",
          MAX_THROTTLE_RETRIES,
          "retries",
        );
        throw new ThrottledExhaustedError();
      }
      const baseMs = THROTTLE_BACKOFF_MS * Math.pow(2, attempt - 1);
      const waitMs = baseMs + jitterMs(400);
      console.info(
        "[shopify-graphql]",
        context ?? "query",
        "Throttled, retry",
        attempt,
        "/",
        MAX_THROTTLE_RETRIES,
        "after",
        waitMs,
        "ms",
      );
      await wait(waitMs);
    }
  }
  throw new ThrottledExhaustedError();
}

/** 画面は優先。バックグラウンドも8件ごとに進め、同時実行は常に1件。 */
const settlementQueue = createSettlementWorkQueue();
const backgroundContext = new AsyncLocalStorage<SettlementPriority>();
export function runAsSettlementBackground<T>(fn: () => Promise<T>, priority: SettlementPriority = {background: true}): Promise<T> {
  return backgroundContext.run(priority, fn);
}
export function promoteSettlementBackground(priority: SettlementPriority): void {
  settlementQueue.promote(priority);
}
export function runSettlementGraphqlSerial<T>(shopId: string, fn: () => Promise<T>): Promise<T> {
  return settlementQueue.run(shopId, backgroundContext.getStore() ?? false, fn);
}

export const SETTLEMENT_THROTTLED_USER_MESSAGE =
  "混雑しています。しばらくしてからお試しください。";
