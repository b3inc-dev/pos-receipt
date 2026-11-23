/**
 * GET /api/settlements/:id/print-payload
 * CloudPRNT 実行経路は廃止。帳票は GET /api/print/settlement/:id + shopify.printing。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { corsJson } = authResult;
    return corsJson(
      {
        ok: false,
        retired: true,
        error:
          "CloudPRNT 直印字経路は廃止しました。精算・点検レシートは Shopify Printing API（/api/print/settlement/:id）を使ってください。",
      },
      { status: 410 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
