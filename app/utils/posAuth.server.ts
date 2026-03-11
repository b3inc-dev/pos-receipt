/**
 * POS UI Extension 認証ヘルパー
 *
 * authenticate.pos(request) でセッショントークンを検証し、
 * unauthenticated.admin でショップの admin クライアントを取得する。
 * CORS 対応済みの corsJson ヘルパーも提供する。
 */
import { authenticate, unauthenticated } from "../shopify.server";
import { resolveShop } from "./shopResolver.server";

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
