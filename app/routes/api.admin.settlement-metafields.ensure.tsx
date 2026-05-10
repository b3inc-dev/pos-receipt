/**
 * POST /api/admin/settlement-metafields/ensure
 * 管理画面: 注文メタフィールド定義を一括作成（冪等）
 * - namespace settlement（精算結果）
 * - namespace pos（特殊返金・商品券調整・返金集計ロケーション等）
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureAllOrderMetafieldDefinitions } from "../services/settlementMetafieldDefinitions.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }
  try {
    const { admin } = await authenticate.admin(request);
    const result = await ensureAllOrderMetafieldDefinitions(admin);
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
