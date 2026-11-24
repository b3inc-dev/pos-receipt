/** デザイン画面に集める既存設定。保存キー/印字の優先関係は維持する。 */
import { DEFAULT_SALES_RECEIPT_SETTINGS, DEFAULT_GIFT_LAYOUT, type SalesReceiptSettings, type GiftLayout } from "../utils/salesReceiptSettings";
import { normalizeTemplateData, type ReceiptTemplateData } from "../utils/receiptTemplateData";
import type { ReceiptKind } from "./receiptLayoutSchema";
export type ReceiptDesignBasics = {
  paperWidthMm: 58 | 80;
  sales?: SalesReceiptSettings;
  gift?: GiftLayout;
  receipt?: ReceiptTemplateData;
  isInspection?: boolean;
  showVoucherChange?: boolean;
};
export const SETTLEMENT_PREVIEW_KEY = "settlement_print_layout_preview";
export function normalizeDesignBasics(raw: Partial<ReceiptDesignBasics>, kind: ReceiptKind): ReceiptDesignBasics {
  const paperWidthMm = raw.paperWidthMm === 58 ? 58 : 80;
  if (kind === "sales" || kind === "gift") return {
    paperWidthMm,
    sales: { ...DEFAULT_SALES_RECEIPT_SETTINGS, ...raw.sales, paperWidthMm,
      layoutJson: { ...DEFAULT_SALES_RECEIPT_SETTINGS.layoutJson, ...raw.sales?.layoutJson } },
    gift: { ...DEFAULT_GIFT_LAYOUT, ...raw.gift },
  };
  if (kind === "receipt") return { paperWidthMm, receipt: normalizeTemplateData(raw.receipt ?? null) };
  return { paperWidthMm, isInspection: raw.isInspection === true, showVoucherChange: raw.showVoucherChange !== false };
}
/** 当該画面が所有しない項目は比較/保存しない（販売とギフトは同じ設定行を部分共有）。 */
export function scopedDesignBasics(raw: ReceiptDesignBasics, kind: ReceiptKind): unknown {
  if (kind === "sales") return { paperWidthMm: raw.paperWidthMm, sales: raw.sales };
  if (kind === "gift") return { paperWidthMm: raw.paperWidthMm, enabled: raw.sales?.enabled, gift: raw.gift };
  return raw;
}
export function validateDesignBasics(raw: unknown, kind: ReceiptKind): string[] {
  if (!raw || typeof raw !== "object") return ["基本設定を読み取れませんでした。画面を開き直してください。"];
  const v = raw as ReceiptDesignBasics;
  const errors: string[] = [];
  if (v.paperWidthMm !== 58 && v.paperWidthMm !== 80) errors.push("用紙幅は58mmか80mmを選んでください。");
  const check = (o: unknown, defaults: object, label: string) => {
    if (!o || typeof o !== "object") { errors.push(`${label}を読み取れませんでした。`); return; }
    for (const [k, d] of Object.entries(defaults)) {
      const x = (o as Record<string, unknown>)[k];
      if (d !== null && typeof d !== "object" && typeof x !== typeof d) errors.push(`${label}の${k}の値が正しくありません。`);
      if (typeof x === "string" && x.length > 100000) errors.push(`${label}の文字が長すぎます。`);
    }
  };
  if (kind === "sales") {
    check(v.sales, DEFAULT_SALES_RECEIPT_SETTINGS, "販売設定");
    check(v.sales?.layoutJson, DEFAULT_SALES_RECEIPT_SETTINGS.layoutJson, "表示項目");
  }
  if (kind === "gift") {
    if (typeof v.sales?.enabled !== "boolean") errors.push("販売・ギフトの印字設定が正しくありません。");
    check(v.gift, DEFAULT_GIFT_LAYOUT, "ギフト設定");
    if (!v.gift?.title?.trim() || v.gift.title.length > 80 || (v.gift.footer?.length ?? 0) > 500) errors.push("ギフトの見出しは1〜80文字、末尾文は500文字以内で入力してください。");
  }
  if (kind === "receipt") check(v.receipt, normalizeTemplateData(null), "領収書設定");
  if (kind === "settlement" && (typeof v.isInspection !== "boolean" || typeof v.showVoucherChange !== "boolean")) errors.push("精算のプレビュー設定が正しくありません。");
  return errors;
}
