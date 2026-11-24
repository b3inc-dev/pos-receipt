/** 認証/プラン制御は集計loader内。表示条件と結果の対応を返して古い数字の再表示を防ぐ。 */
import type { LoaderFunctionArgs } from "react-router";
import { loadAdminSalesSummary } from "../services/salesSummaryAdmin.server";
export async function loader(args: LoaderFunctionArgs) {
  const result = await loadAdminSalesSummary(args);
  if (result instanceof Response) return result;
  return {...result, requestKey: new URL(args.request.url).search};
}
