/**
 * POS UI Extension 認証ヘルパー
 *
 * authenticate.pos(request) でセッショントークンを検証し、
 * unauthenticated.admin でショップの admin クライアントを取得する。
 * CORS 対応済みの corsJson ヘルパーも提供する。
 *
 * 認証失敗時（401 等）はライブラリが CORS なしの Response を throw するため、
 * POS からは読み取れず「読み込みに失敗しました」になる。そのためエラー時も CORS を付与する。
 */
import { authenticate, unauthenticated } from "../shopify.server";
import { resolveShop } from "./shopResolver.server";

/** CORS プリフライト（OPTIONS）用の 204 レスポンス。POST 前にブラウザが送る OPTIONS に必須。 */
export function corsPreflightResponse(request: Request): Response {
  const origin = request.headers.get("Origin") || "*";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

/** レスポンスに POS 用 CORS ヘッダーを付与する（認証失敗時などで使用） */
function addCorsToResponse(request: Request, response: Response): Response {
  const origin = request.headers.get("Origin");
  const res = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
  res.headers.set("Access-Control-Allow-Origin", origin || "*");
  res.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (!res.headers.has("Content-Type")) {
    res.headers.set("Content-Type", "application/json");
  }
  return res;
}

/** CORS 付きの JSON エラーレスポンスを作る（catch 内で corsJson が使えない場合用） */
export function corsErrorJson(
  request: Request,
  data: { ok?: boolean; error?: string },
  status: number
): Response {
  return addCorsToResponse(
    request,
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

export async function authenticatePosRequest(request: Request) {
  const { sessionToken, cors } = await authenticate.pos(request);
  const shopDomain = new URL(sessionToken.dest as string).hostname;
  const { admin } = await unauthenticated.admin(shopDomain);
  const shop = await resolveShop(shopDomain, admin);

  /** CORS ヘッダー付きの JSON レスポンスを返すヘルパー */
  const corsJson = (data: unknown, init?: ResponseInit): Promise<Response> =>
    cors(Response.json(data, init));

  return { admin, shop, corsJson };
}

/**
 * POS API 用: 認証を試し、失敗時は CORS 付きのエラーレスポンスを返す。
 * 管理画面は問題ないが POS だけ「読み込みに失敗しました」になる場合、認証エラーが CORS なしで返っている可能性があるためこれを使用する。
 */
export async function authenticatePosRequestOrCorsError(
  request: Request
): Promise<{ admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"]; shop: Awaited<ReturnType<typeof resolveShop>>; corsJson: (data: unknown, init?: ResponseInit) => Promise<Response> } | Response> {
  try {
    return await authenticatePosRequest(request);
  } catch (err) {
    if (err instanceof Response) {
      return addCorsToResponse(request, err);
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return addCorsToResponse(
      request,
      new Response(JSON.stringify({ ok: false, error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    );
  }
}
