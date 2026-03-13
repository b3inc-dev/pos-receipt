/**
 * /app/plan/callback — Shopify 課金承認コールバック
 * Shopify の課金承認後にリダイレクトされる URL
 */
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const url = new URL(request.url);
  const plan = url.searchParams.get("plan") ?? "lite";

  // planCode を DB に保存（lite / standard / pro を許容。standard は後方互換で lite 相当）
  if (plan === "pro" || plan === "lite" || plan === "standard") {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { planCode: plan === "standard" ? "lite" : plan },
    });
  }

  return redirect("/app/plan");
}
