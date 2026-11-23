/**
 * /app/location-profiles — 前の「設定軸・一括反映」。
 * 全店の決まり・選んだ店をまとめて変更・店ごとの編集は、店舗の画面（/app/settings）に移した（T 11/23）。
 * 前の画面を開いたままの人・ブックマークのために、店舗の画面へ移す。保存済みのプロファイル（AppSetting location_setting_profiles）は消さない。
 */
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  const url = new URL(request.url);
  return redirect(`/app/settings${url.search}`);
}
