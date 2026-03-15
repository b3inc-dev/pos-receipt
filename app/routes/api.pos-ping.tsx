/**
 * GET /api/pos-ping
 * POS からの接続確認用。認証不要。CORS 付きで 200 を返す。
 * 「接続先と認証を確認してください」が出る場合、まずこの URL にブラウザや POS から届くか確認する。
 */
import type { LoaderFunctionArgs } from "react-router";

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Content-Type": "application/json",
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const body = JSON.stringify({
    ok: true,
    message: "POS API is reachable",
    method: request.method,
  });
  return new Response(body, {
    status: 200,
    headers: corsHeaders(request),
  });
}

export async function action({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  const body = JSON.stringify({
    ok: true,
    message: "POS API is reachable",
    method: request.method,
  });
  return new Response(body, {
    status: 200,
    headers: corsHeaders(request),
  });
}
