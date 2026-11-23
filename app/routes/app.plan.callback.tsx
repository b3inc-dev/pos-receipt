/**
 * /app/plan/callback — 以前の Billing API（appSubscriptionCreate）の承認のあとに戻る URL。
 *
 * 2026-11-21 T の決定で公開用の料金は Shopify App Pricing になり、アプリは契約を作らない。
 * プランは shopPlan.server.ts が Shopify の契約から読むので、ここでは planCode を書かない
 * （URL の ?plan= で planCode を変えられないようにする）。古いリンクから来たときのために料金プラン画面へ戻すだけ。
 */
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  const url = new URL(request.url);
  url.searchParams.delete("plan");
  url.searchParams.delete("charge_id");
  const rest = url.searchParams.toString();
  return redirect(`/app/plan${rest ? `?${rest}` : ""}`);
}
