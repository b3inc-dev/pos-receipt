/** 旧一覧URLは売上サマリーへ。ブックマークの条件を保持する。 */
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
export async function loader({request}: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return redirect("/app/sales-summary" + new URL(request.url).search);
}
