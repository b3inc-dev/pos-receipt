import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { ensureAllOrderMetafieldDefinitions } from "../services/settlementMetafieldDefinitions.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  // インストール直後: settlement.*（精算結果）と pos.*（特殊返金・商品券調整等）の Order メタ定義を自動作成（失敗しても OAuth は完了させる）
  try {
    await ensureAllOrderMetafieldDefinitions(admin);
  } catch (e) {
    console.error("[auth] ensureAllOrderMetafieldDefinitions failed:", e);
  }
  return redirect("/app");
};

export const headers = boundary.headers;
