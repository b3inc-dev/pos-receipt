/**
 * 管理画面で作ったレイアウト（#69）を印字の道で使う
 *
 * - 「このレイアウトで印字する」を入れた種類だけ使う。入れていなければ null を返し、呼ぶ側は今までの印字（printReceiptHtml.ts）のまま
 * - 用紙の幅は、帳票の中身ではなく出力機器の設定（再印刷の時点）を使う（#22 と同じ考え）
 * - 印字の HTML ではスクリプト・外のファイルの読み込みを止める（コードで <script> を書いても動かない）
 * - テンプレートの誤りで作れなかったときも null（今までの印字で出す。紙が出ないよりよい）
 */
import { getAppSetting } from "../utils/appSettings.server";
import { normalizeLayout } from "./receiptLayoutValidate";
import { renderReceiptLayout } from "./receiptLayoutRender";
import {
  RECEIPT_KINDS,
  receiptLayoutSettingKey,
  type ReceiptKind,
  type ReceiptLayout,
} from "./receiptLayoutSchema";
import {
  normalizeSettlementCalc,
  SETTLEMENT_CALC_SETTING_KEY,
  type SettlementCalcSettings,
} from "./receiptLayoutSettlementCalc";
import type { ReceiptTemplateData } from "./receiptLayoutData";

export const LAYOUT_PRINT_ENABLED_KEY = "receipt_layout_print_v1";

export type LayoutPrintEnabled = Record<ReceiptKind, boolean>;

export function normalizePrintEnabled(raw: unknown): LayoutPrintEnabled {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(RECEIPT_KINDS.map((k) => [k, o[k] === true])) as LayoutPrintEnabled;
}

export async function getLayoutPrintEnabled(shopId: string): Promise<LayoutPrintEnabled> {
  return normalizePrintEnabled(await getAppSetting<unknown>(shopId, LAYOUT_PRINT_ENABLED_KEY));
}

export async function getSettlementCalc(shopId: string): Promise<SettlementCalcSettings> {
  return normalizeSettlementCalc(await getAppSetting<unknown>(shopId, SETTLEMENT_CALC_SETTING_KEY));
}

/** 印字に使うレイアウト。使わない（オン にしていない・保存が無い）なら null */
export async function getPrintLayout(shopId: string, kind: ReceiptKind): Promise<ReceiptLayout | null> {
  const enabled = await getLayoutPrintEnabled(shopId);
  if (!enabled[kind]) return null;
  const raw = await getAppSetting<unknown>(shopId, receiptLayoutSettingKey(kind));
  if (raw === null || raw === undefined) return null;
  return normalizeLayout(raw, kind);
}

/**
 * 印字の HTML ではスクリプト・フォーム・外の CSS とフォントを止める。
 * 画像は https と data: だけ（ロゴ・QR）。
 */
export const PRINT_CSP =
  "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; form-action 'none'; base-uri 'none'";

export function withPrintCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}"/>`;
  // <head> の先頭に入れる（テンプレートの <script> より前でないと効かない）
  const m = /<head(\s[^>]*)?>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + meta + html.slice(m.index + m[0].length);
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"/>${meta}</head><body>${html}</body></html>`;
}

/** レイアウトで印字の HTML を作る。作れなかったら null（呼ぶ側は今までの印字で出す） */
export function renderLayoutForPrint(
  layout: ReceiptLayout,
  data: ReceiptTemplateData,
  paperWidthMm: 58 | 80,
): string | null {
  const result = renderReceiptLayout({ ...layout, paperWidthMm }, data as unknown as Record<string, unknown>);
  if (!result.ok) {
    console.warn("[receipt-layout] print render failed; falling back", { kind: layout.kind, error: result.error.slice(0, 200) });
    return null;
  }
  return withPrintCsp(result.html);
}
