/**
 * LINE id_token 検証（LINE verify endpoint 使用）
 * LIFF から受け取った id_token を検証し、sub（LINE user ID）を返す。
 */

const LINE_VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";

export interface LineVerifyResult {
  ok: true;
  sub: string;
}

export interface LineVerifyError {
  ok: false;
  /**
   * - ID_TOKEN_EXPIRED: トークンの期限が本当に切れている（再読み込みで直る）
   * - LINE_UNAVAILABLE: LINE 側の混雑・障害・通信の失敗（429・5xx・応答なし）。トークンが悪いとは限らない
   * - LINE_AUTH_FAILED: それ以外（トークンが正しくない・チャネル ID の設定ちがいなど）
   */
  error: "LINE_AUTH_FAILED" | "ID_TOKEN_EXPIRED" | "LINE_UNAVAILABLE";
}

/** 期限の比べ方の余裕（サーバーの時計のずれ）。期限の少し前に断られても期限切れとは言わない */
const EXPIRY_SKEW_MS = 30_000;

/**
 * ID トークン（JWT）の exp（秒）を読む。署名は確かめない（LINE が断ったあとの「理由の見分け」にだけ使う。
 * 読めた値で会員を通すことはない）。読めなければ null。
 */
export function readIdTokenExpMs(idToken: string): number | null {
  const parts = String(idToken ?? "").split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const exp = (JSON.parse(json) as { exp?: unknown })?.exp;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** LINE の答えの `error`（OAuth の決まった短い名前）だけを読む。形が違えば null（本文は読まない・残さない） */
function readOauthErrorCode(bodyText: string): string | null {
  try {
    const code = (JSON.parse(bodyText) as { error?: unknown })?.error;
    return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * LINE の検証 API が断ったときの理由を決める（Shopify・LINE を呼ばない。試験で直接確かめる）。
 * - 429・5xx → LINE_UNAVAILABLE（本文に「expired」が入っていても期限切れにしない）
 * - 400 invalid_request で、トークンの exp がもう過ぎている → ID_TOKEN_EXPIRED
 * - それ以外 → LINE_AUTH_FAILED（本文の文字を探して期限切れにしない）
 * ログに出してよいのは、返す logLine だけ（HTTP の番号と、LINE の決まった error の名前）。
 */
export function classifyLineVerifyFailure(input: {
  status: number;
  bodyText: string;
  idToken: string;
  nowMs: number;
}): { error: LineVerifyError["error"]; logLine: string } {
  const { status, bodyText, idToken, nowMs } = input;
  const code = readOauthErrorCode(bodyText);
  const tag = `status=${status}${code ? ` error=${code}` : ""}`;
  if (status === 429 || status >= 500) {
    return { error: "LINE_UNAVAILABLE", logLine: `[member-card] LINE verify unavailable: ${tag}` };
  }
  const expMs = readIdTokenExpMs(idToken);
  if (status === 400 && code === "invalid_request" && expMs != null && expMs + EXPIRY_SKEW_MS <= nowMs) {
    return { error: "ID_TOKEN_EXPIRED", logLine: `[member-card] ID_TOKEN_EXPIRED: ${tag}` };
  }
  return { error: "LINE_AUTH_FAILED", logLine: `[member-card] LINE verify failed: ${tag}` };
}

export type LineVerifyResponse = LineVerifyResult | LineVerifyError;

/**
 * LINE の ID トークン検証 API を呼び出し、検証成功時は sub（LINE user ID）を返す。
 */
export async function verifyLineIdToken(idToken: string): Promise<LineVerifyResponse> {
  const channelId = process.env.LINE_CHANNEL_ID?.trim();
  if (!channelId) {
    console.error("LINE_CHANNEL_ID is not set");
    return { ok: false, error: "LINE_AUTH_FAILED" };
  }

  const body = new URLSearchParams({
    id_token: idToken,
    client_id: channelId,
  });

  try {
    const res = await fetch(LINE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      // 本文はログに出さない（LINE の答えにはトークンや設定の中身が入ることがある）。理由の見分けにだけ使う
      const text = await res.text().catch(() => "");
      const failure = classifyLineVerifyFailure({ status: res.status, bodyText: text, idToken, nowMs: Date.now() });
      if (failure.error === "ID_TOKEN_EXPIRED") console.warn(failure.logLine);
      else console.error(failure.logLine);
      return { ok: false, error: failure.error };
    }

    const data = (await res.json()) as { sub?: string };
    const sub = data?.sub?.trim();
    if (!sub) {
      console.error("LINE verify response missing sub");
      return { ok: false, error: "LINE_AUTH_FAILED" };
    }

    return { ok: true, sub };
  } catch (err) {
    // 例外の文に送った中身が入ることがあるので、種類の名前だけを出す
    const kind = err instanceof Error ? err.name : typeof err;
    console.error(`[member-card] LINE verify request error: ${kind}`);
    return { ok: false, error: "LINE_UNAVAILABLE" };
  }
}
