/**
 * GET  /api/voucher-adjustments/from-cart → { enabled }（POS の「商品券」タイルが、会計前の額面入力を出すか決める）
 * POST /api/voucher-adjustments/from-cart
 * 会計後の画面（POS「商品券」の会計後の枠）から呼ぶ。本文: { sourceOrderId, locationId?, createdBy? }
 * 会計の前に入れた額面（注文の見えない項目）があれば、商品券調整を 1 件だけ登録する（docs/VOUCHER_CART_ENTRY.md）。
 * 同じ注文で何回呼んでも 1 件（2 回目からは status: "already"）。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import { registerVoucherFromCartEntry, voucherCartEntryEnabled } from "../services/voucherCartEntry.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { shop, corsJson } = authResult;
    return corsJson({ ok: true, enabled: await voucherCartEntryEnabled(shop.id) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (request.method !== "POST") {
    return corsErrorJson(request, { error: "Method not allowed" }, 405);
  }
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const sourceOrderId = body.sourceOrderId != null ? String(body.sourceOrderId) : "";
    if (!sourceOrderId) {
      return corsJson({ ok: false, error: "sourceOrderId is required" }, { status: 400 });
    }
    const result = await registerVoucherFromCartEntry(admin, shop.id, sourceOrderId, {
      locationId: body.locationId != null ? String(body.locationId) : null,
      createdBy: body.createdBy != null ? String(body.createdBy) : null,
    });
    return corsJson({ ok: true, ...result }, { status: result.status === "created" ? 201 : 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
