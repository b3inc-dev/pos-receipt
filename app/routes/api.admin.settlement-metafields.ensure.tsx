/**
 * POST /api/admin/settlement-metafields/ensure
 * 管理画面: 注文の精算メタフィールド定義（namespace settlement）を一括作成（冪等）
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureSettlementOrderMetafieldDefinitions } from "../services/settlementMetafieldDefinitions.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }
  try {
    const { admin } = await authenticate.admin(request);
    const result = await ensureSettlementOrderMetafieldDefinitions(admin);
    return Response.json({
      ok: result.ok,
      created: result.created,
      skipped: result.skipped,
      errors: result.errors,
      message: result.ok
        ? `作成: ${result.created.length}件 / 既存スキップ: ${result.skipped.length}件`
        : `一部失敗: エラー ${result.errors.length}件（作成 ${result.created.length} / スキップ ${result.skipped.length}）`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
