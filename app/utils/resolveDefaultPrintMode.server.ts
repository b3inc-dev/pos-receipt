/**
 * ショップ print_settings.defaultPrintMode → 新規 Location 作成時の初期 printMode
 * 実効印字方式は常に Location.printMode（D3）。本値は初期コピー専用。
 */
import {
  getAppSetting,
  PRINT_SETTINGS_KEY,
  DEFAULT_PRINT_SETTINGS,
  type PrintSettings,
} from "./appSettings.server";

export type LocationPrintMode = "order_based" | "cloudprnt_direct";

export async function resolveDefaultLocationPrintMode(
  shopId: string,
): Promise<LocationPrintMode> {
  const settings =
    (await getAppSetting<Partial<PrintSettings>>(shopId, PRINT_SETTINGS_KEY)) ?? {};
  const mode = settings.defaultPrintMode ?? DEFAULT_PRINT_SETTINGS.defaultPrintMode;
  return mode === "cloudprnt_direct" ? "cloudprnt_direct" : "order_based";
}
