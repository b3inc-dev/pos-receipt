/**
 * shop/redact の前に「この店にアプリをまた入れていないか」を確かめる部品（Location Stock と同じ考え）。
 *
 * shop/redact はアンインストールの 48 時間後に届く。そのあいだに入れ直した店に届いたとき、
 * 入れ直したあとのデータ（精算・領収書・設定など）を消さないよう、消す前に確かめる。
 *
 * このアプリはアンインストールの webhook でセッションを消す（webhooks.app.uninstalled.tsx）。
 * そのため、オフラインのセッションが残っていれば「入れ直したかもしれない」と見て、Admin API を 1 回呼ぶ。
 * - オフラインのセッションが無い → 入っていない → 消してよい（false）
 * - 呼べた → 今も入っている（入れ直した）→ 消さない（true）
 * - 401 / トークンが無効 → 入っていない → 消してよい（false）
 *   （403 は権限の問題などでも返るので「入っていない」とは見ない）
 * - それ以外の失敗（DB・通信・5xx など）→ 分からないので投げる（ルートが 500 を返し、Shopify がもう一度送る）
 */

export const INSTALL_PROBE_QUERY = `#graphql
  query ComplianceInstallProbe {
    shop { id }
  }
`;

function statusOf(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  if (typeof Response !== "undefined" && err instanceof Response) return err.status;
  const e = err as {
    response?: { code?: unknown; status?: unknown };
    status?: unknown;
    statusCode?: unknown;
  };
  const candidates = [e.response?.code, e.response?.status, e.status, e.statusCode];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

/** 失敗が「アプリが入っていない／トークンが無効」を表すか */
export function isNotInstalledError(err: unknown): boolean {
  if (statusOf(err) === 401) return true;
  const e = (err ?? {}) as { message?: unknown; response?: { body?: unknown } };
  const text = [
    typeof e.message === "string" ? e.message : "",
    e.response?.body ? JSON.stringify(e.response.body) : "",
  ]
    .filter(Boolean)
    .join(" ");
  return /invalid_grant|invalid_token|invalid_subject_token|Invalid API key or access token|SessionNotFound|Could not find a session/i.test(
    text,
  );
}

export type InstallProbeDeps = {
  shop: string;
  /** その店のオフラインのセッション（無ければ null） */
  findOfflineSession: (shop: string) => Promise<unknown | null | undefined>;
  /** Admin API を 1 回呼ぶ。呼べなければ投げる */
  runProbeQuery: (shop: string) => Promise<unknown>;
};

/** true = 今も入っている（消さない） */
export async function probeShopStillInstalled({
  shop,
  findOfflineSession,
  runProbeQuery,
}: InstallProbeDeps): Promise<boolean> {
  const session = await findOfflineSession(shop);
  if (!session) return false;
  try {
    await runProbeQuery(shop);
    return true;
  } catch (err) {
    if (isNotInstalledError(err)) return false;
    throw err;
  }
}

/**
 * authenticate.webhook() が返す topic は "SHOP_REDACT" の形（@shopify/shopify-api 12.3.0 の
 * topicForStorage が大文字にして "/" を "_" にする）。ヘッダーそのままの "shop/redact" が来ても同じに扱う。
 */
export function normalizeWebhookTopic(topic: unknown): string {
  return String(topic ?? "")
    .trim()
    .toUpperCase()
    .replace(/[/.\s-]+/g, "_");
}
