/**
 * POST /api/print/printed  { kind: "receipt" | "sales" | "gift", id }
 * POS が領収書・販売レシート・ギフトレシートの印刷を受け付けたあとに呼ぶ。
 * 次からの印刷を「再印字」と見分けるためだけの記録（金額・件数・Shopify には書かない）。
 * 精算・点検は今までどおり POST /api/settlements/print（Settlement.printedAt）。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  authenticatePosRequestOrCorsError,
  corsErrorJson,
  corsPreflightResponse,
} from "../utils/posAuth.server";
import prisma from "../db.server";
import { isPrintRecordKind } from "../services/printMarks";
import { recordPrinted } from "../services/printMarks.server";

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { shop, corsJson } = authResult;
    if (request.method !== "POST") return corsJson({ ok: false, error: "Method not allowed" }, { status: 405 });

    const body = (await request.json().catch(() => ({}))) as { kind?: unknown; id?: unknown };
    const id = String(body.id ?? "").trim();
    if (!isPrintRecordKind(body.kind) || !id || id.length > 200) {
      return corsJson({ ok: false, error: "kind と id が必要です" }, { status: 400 });
    }
    if (body.kind === "receipt") {
      const issued = await prisma.receiptIssue.findFirst({ where: { id, shopId: shop.id }, select: { id: true } });
      if (!issued) return corsJson({ ok: false, error: "領収書が見つかりません" }, { status: 404 });
    }
    await recordPrinted(shop.id, body.kind, id);
    return corsJson({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
