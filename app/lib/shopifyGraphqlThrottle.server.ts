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
 */
export async function adminGraphqlWithRetry<TJson = unknown>(
  admin: AdminGraphqlClient,
  query: string,
  options?: object,
  context?: string,
): Promise<TJson> {
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
      await sleep(waitMs);
    }
  }
  throw new ThrottledExhaustedError();
}

/** ショップ単位で精算系 GraphQL を直列化（同時プレビューで枠を使い切らない） */
const shopSettlementGraphqlQueue = new Map<string, Promise<unknown>>();

export async function runSettlementGraphqlSerial<T>(
  shopId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = shopSettlementGraphqlQueue.get(shopId) ?? Promise.resolve();
  const task = prev
    .then(() => fn())
    .finally(() => {
      if (shopSettlementGraphqlQueue.get(shopId) === task) {
        shopSettlementGraphqlQueue.delete(shopId);
      }
    });
  shopSettlementGraphqlQueue.set(shopId, task);
  return task as Promise<T>;
}

export const SETTLEMENT_THROTTLED_USER_MESSAGE =
  "混雑しています。しばらくしてからお試しください。";
