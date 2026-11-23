/**
 * Shopify Admin GraphQL の Throttled 対策（リトライ・バックオフ）
 * GAS 精算スクリプトの graphqlFetch 相当。会員カード customer.server と同方針。
 */
import { AsyncLocalStorage } from "node:async_hooks";

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

/**
 * ショップ単位で精算系 GraphQL を直列化（同時プレビューで枠を使い切らない）。
 *
 * 画面を開いた人の集計（管理画面・POS）を先に進め、Webhook の裏の再計算は
 * その合間に進める。裏の処理は runAsSettlementBackground の中で呼ぶ。
 * 1 件ずつ順に動かすことは前と同じ（Shopify の枠の使い方は変えない）。
 * 前の 1 件が失敗しても、次の 1 件はそのまま動かす。
 */
type SerialTask = {
  background: boolean;
  start: () => void;
};
type ShopSerialState = {
  running: boolean;
  tasks: SerialTask[];
  /** 画面からの 1 件が終わった時刻（続きの 1 件が来るまで裏の処理を少し待たせる） */
  lastInteractiveEndAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};
const shopSettlementGraphqlQueue = new Map<string, ShopSerialState>();
const settlementBackgroundContext = new AsyncLocalStorage<boolean>();
/**
 * 画面の集計は店ごとに 1 件ずつ続けて積まれる。1 件が終わってから次が積まれるまでの
 * 短い間に裏の処理が割り込まないよう、この時間だけ裏の処理を待たせる。
 */
const INTERACTIVE_GRACE_MS = 1500;

/** この中で呼んだ精算系の集計は、画面からの集計より後回しにする（Webhook の裏の再計算用） */
export function runAsSettlementBackground<T>(fn: () => Promise<T>): Promise<T> {
  return settlementBackgroundContext.run(true, fn);
}

function startNextSerialTask(shopId: string): void {
  const state = shopSettlementGraphqlQueue.get(shopId);
  if (!state || state.running) return;
  // 店ごとの状態は小さいので消さずに持つ（待たせる時間の基準を失わないため）
  if (state.tasks.length === 0) return;
  let idx = state.tasks.findIndex((t) => !t.background);
  if (idx < 0) {
    const wait = state.lastInteractiveEndAt + INTERACTIVE_GRACE_MS - Date.now();
    if (wait > 0) {
      if (!state.timer) {
        state.timer = setTimeout(() => {
          state.timer = null;
          startNextSerialTask(shopId);
        }, wait);
      }
      return;
    }
    idx = 0;
  }
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const [next] = state.tasks.splice(idx, 1);
  state.running = true;
  next.start();
}

export async function runSettlementGraphqlSerial<T>(
  shopId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const background = settlementBackgroundContext.getStore() === true;
  let state = shopSettlementGraphqlQueue.get(shopId);
  if (!state) {
    state = { running: false, tasks: [], lastInteractiveEndAt: 0, timer: null };
    shopSettlementGraphqlQueue.set(shopId, state);
  }
  const s = state;
  return new Promise<T>((resolve, reject) => {
    s.tasks.push({
      background,
      start: () => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            s.running = false;
            if (!background) s.lastInteractiveEndAt = Date.now();
            startNextSerialTask(shopId);
          });
      },
    });
    startNextSerialTask(shopId);
  });
}

/** 試験用: いま待っている件数 */
export function pendingSettlementSerialTasks(shopId: string): number {
  const st = shopSettlementGraphqlQueue.get(shopId);
  return st ? st.tasks.length + (st.running ? 1 : 0) : 0;
}

export const SETTLEMENT_THROTTLED_USER_MESSAGE =
  "混雑しています。しばらくしてからお試しください。";
