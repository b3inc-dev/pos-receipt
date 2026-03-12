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
  error: "LINE_AUTH_FAILED";
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
      const text = await res.text();
      console.error("[member-card] LINE verify failed:", res.status, text);
      return { ok: false, error: "LINE_AUTH_FAILED" };
    }

    const data = (await res.json()) as { sub?: string };
    const sub = data?.sub?.trim();
    if (!sub) {
      console.error("LINE verify response missing sub");
      return { ok: false, error: "LINE_AUTH_FAILED" };
    }

    return { ok: true, sub };
  } catch (err) {
    console.error("LINE verify request error:", err);
    return { ok: false, error: "LINE_AUTH_FAILED" };
  }
}
