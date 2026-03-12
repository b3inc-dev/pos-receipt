/**
 * POST /api/member-card
 * LIFF 会員証用 API。カスタムアプリ（APP_DISTRIBUTION=inhouse）でのみ有効。
 * OPTIONS（CORS プリフライト）は loader で処理する。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { unauthenticated } from "../shopify.server";
import { verifyLineIdToken } from "../lib/line.server";
import { getMemberIdByLineId } from "../lib/customer.server";
import { isInhouseMode } from "../utils/planFeatures.server";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(
  data: Record<string, unknown>,
  init: ResponseInit = {}
): Response {
  const headers = new Headers(init.headers);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return jsonResponse({ ok: false, message: "METHOD_NOT_ALLOWED" }, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {

  if (request.method === "POST") {
    console.info("[member-card] POST /api/member-card received");
  }

  if (!isInhouseMode()) {
    return jsonResponse({ ok: false, message: "FORBIDDEN" }, { status: 403 });
  }

  if (request.method !== "POST") {
    return jsonResponse(
      { ok: false, message: "SYSTEM_ERROR" },
      { status: 405 }
    );
  }

  let body: { idToken?: string; shop?: string };
  try {
    body = (await request.json()) as { idToken?: string; shop?: string };
  } catch {
    return jsonResponse(
      { ok: false, message: "SYSTEM_ERROR" },
      { status: 400 }
    );
  }

  const idToken = typeof body.idToken === "string" ? body.idToken.trim() : "";
  const shop = typeof body.shop === "string" ? body.shop.trim() : "";

  if (!idToken || !shop) {
    return jsonResponse(
      { ok: false, message: "SYSTEM_ERROR" },
      { status: 400 }
    );
  }

  const verifyResult = await verifyLineIdToken(idToken);
  if (!verifyResult.ok) {
    console.error("[member-card] id_token verify failed for shop:", shop);
    const message = verifyResult.error === "ID_TOKEN_EXPIRED" ? "ID_TOKEN_EXPIRED" : "LINE_AUTH_FAILED";
    return jsonResponse({ ok: false, message }, { status: 401 });
  }

  let admin;
  try {
    const result = await unauthenticated.admin(shop);
    admin = result.admin;
  } catch (err) {
    console.error("unauthenticated.admin failed for shop:", shop, err);
    return jsonResponse(
      { ok: false, message: "SYSTEM_ERROR" },
      { status: 500 }
    );
  }

  const memberResult = await getMemberIdByLineId(admin, verifyResult.sub);

  if (!memberResult.ok) {
    const status =
      memberResult.error === "CUSTOMER_NOT_FOUND"
        ? 404
        : memberResult.error === "MEMBER_ID_NOT_SET"
          ? 422
          : 500;
    const message =
      memberResult.error === "CUSTOMER_NOT_FOUND"
        ? "CUSTOMER_NOT_LINKED"
        : memberResult.error === "MEMBER_ID_NOT_SET"
          ? "MEMBER_ID_NOT_SET"
          : "SYSTEM_ERROR";
    return jsonResponse({ ok: false, message }, { status });
  }

  return jsonResponse({
    ok: true,
    memberId: memberResult.memberId,
  });
}
