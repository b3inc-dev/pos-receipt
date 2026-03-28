import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { ensureSettlementOrderMetafieldDefinitions } from "../services/settlementMetafieldDefinitions.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  // インストール直後: 注文印字（精算）用メタ定義を自動作成（失敗しても OAuth は完了させる）
  try {
    await ensureSettlementOrderMetafieldDefinitions(admin);
  } catch (e) {
    console.error("[auth] ensureSettlementOrderMetafieldDefinitions failed:", e);
  }
  return redirect("/app");
};

export const headers = boundary.headers;
