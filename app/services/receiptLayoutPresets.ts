/**
 * レイアウトのひな形
 *
 * - 標準: 一般の店向け。今の印字（printReceiptHtml.ts）と同じ項目・順番
 * - Ciara 風: Ciara が Shopify の「印刷用レシートのコード」で作っている見た目を、ブロックだけで作ったもの
 *   （T さんの参考画像 2026-11-22 から。会社名・住所・登録番号などは店ごとの値なので空にしてある）
 *   精算レシートは画像に写っていないので、gift-receipt.liquid のメタフィールドの順に並べた仮の形（未確認）
 */
import { defaultSettings, getBlockDef } from "./receiptLayoutBlocks";
import {
  DEFAULT_LAYOUT_STYLE,
  type BlockSettingValue,
  type LayoutBlock,
  type LayoutStyle,
  type ReceiptKind,
  type ReceiptLayout,
} from "./receiptLayoutSchema";

function block(id: string, type: string, settings: Record<string, BlockSettingValue> = {}, hidden = false): LayoutBlock {
  const def = getBlockDef(type);
  if (!def) throw new Error(`unknown block ${type}`);
  return { id, type, hidden, settings: { ...defaultSettings(def), ...settings } };
}

function layout(kind: ReceiptKind, blocks: LayoutBlock[], style: Partial<LayoutStyle> = {}): ReceiptLayout {
  return { version: 1, kind, mode: "blocks", paperWidthMm: 80, style: { ...DEFAULT_LAYOUT_STYLE, ...style }, blocks, code: "" };
}

const row = (id: string, field: string, label: string, extra: Record<string, BlockSettingValue> = {}) =>
  block(id, "settlement_row", { field, label, ...extra });

/** 標準のひな形（初めて開いたとき・保存が無いとき） */
export function defaultLayout(kind: ReceiptKind): ReceiptLayout {
  switch (kind) {
    case "sales":
      return layout("sales", [
        block("title", "heading", { text: "{{ shop.name }}", size: "l" }),
        block("order", "order_info", { show_date: true, show_order_name: true }),
        block("store", "store_info", { show_name: true, name_bold: false, show_address: false, show_phone: false, size: "s" }),
        block("hr1", "divider", { style: "dashed" }),
        block("items", "line_items", { show_header: false, show_sku: false, quantity: "always" }),
        block("hr2", "divider", { style: "dashed" }),
        block("totals", "totals", { tax_label: "税", total_size: "l" }),
        block("hr3", "divider", { style: "dashed" }),
        block("payments", "payments"),
        block("attrs", "order_attributes", { heading: "注文属性" }, true),
        block("footer", "text", { text: "", size: "s" }),
      ]);
    case "gift":
      return layout("gift", [
        block("title", "heading", { text: "ギフトレシート", size: "l" }),
        block("store", "store_info", { show_address: false, show_phone: false, size: "s" }),
        block("order", "order_info", { show_date: false, show_order_name: true }),
        block("hr1", "divider", { style: "dashed" }),
        block("items", "gift_items"),
        block("hr2", "divider", { style: "dashed" }),
        block("footer", "text", { text: "", size: "s" }),
      ]);
    case "settlement":
      return layout("settlement", [
        block("title", "heading", { text: "{{ settlement.title }}", size: "l" }),
        block("meta", "settlement_meta"),
        block("hr1", "divider", { style: "dashed" }),
        row("total", "total", "総売上"),
        row("net", "net_sales", "純売上"),
        row("tax", "tax", "消費税"),
        row("disc", "discounts", "割引"),
        row("refund", "refund_total", "返金"),
        row("orders", "order_count", "件数", { unit: "件" }),
        row("items", "item_count", "点数", { unit: "点" }),
        row("voucher", "voucher_change", "商品券釣有り差額", { hide_zero: true }),
        block("hr2", "divider", { style: "dashed" }),
        block("payments", "settlement_payments"),
      ]);
    case "receipt":
      return layout("receipt", [
        block("title", "heading", { text: "領　収　書", size: "l" }),
        block("issuer", "issuer"),
        block("hr1", "divider", { style: "dashed" }),
        block("recipient", "receipt_recipient"),
        block("amount", "receipt_amount", { size: "l", suffix: "", underline: "none" }),
        block("breakdown", "receipt_breakdown"),
        block("proviso", "receipt_proviso", { underline: "none" }),
        block("meta", "receipt_meta"),
      ]);
  }
}

// ── Ciara 風 ────────────────────────────────────────────

const CIARA_STYLE: Partial<LayoutStyle> = { fontWeight: 600, fontSizePx: 14, lineHeight: 1.35, paddingPx: 16 };
const CIARA_LOGO_CSS = ".logo-text{font-family:\"Didot\",\"Bodoni 72\",\"Times New Roman\",serif;font-weight:400;font-size:3.4em;line-height:1.1}";

function ciaraLogo(): LayoutBlock {
  return block("logo", "logo", { image_url: "", text: "Ciara", width_percent: 50, bold: false, align: "center" });
}

export function ciaraSalesLayout(): ReceiptLayout {
  return layout(
    "sales",
    [
      ciaraLogo(),
      block("title", "heading", { text: "領収書", size: "m", bold: true }),
      block("store", "store_info", { name_bold: true, size: "m" }),
      block("items", "line_items", {
        header_left: "アイテム",
        header_right: "商品価格",
        header_line: "solid",
        show_variant: true,
        show_sku: true,
        quantity: "multiple",
      }),
      block("hr1", "divider", { style: "dotted" }),
      block("totals", "totals", {
        subtotal_label: "小計",
        tax_label: "CT",
        tax_note: "商品価格に含まれています",
        total_label: "合計",
        total_size: "m",
        total_bold: false,
      }),
      block("hr2", "divider", { style: "thick" }),
      block("payments", "payments"),
      block("hr3", "divider", { style: "thick" }),
      block("order", "order_info", {
        show_date: true,
        show_staff: true,
        staff_label: "スタッフ：",
        show_order_name: true,
        order_label: "領収書: ",
        align: "center",
      }),
      block("registration", "text", { text: "", align: "center" }),
    ],
    { ...CIARA_STYLE, customCss: CIARA_LOGO_CSS },
  );
}

export function ciaraReceiptLayout(): ReceiptLayout {
  return layout(
    "receipt",
    [
      ciaraLogo(),
      block("title", "heading", { text: "領収書", size: "l", bold: false }),
      block("sp1", "spacer", { height: 16 }),
      block("recipient", "receipt_recipient", { suffix: "様", underline: "solid" }),
      block("amount", "receipt_amount", { suffix: "-", size: "xl", underline: "solid" }),
      block("breakdown", "receipt_breakdown", { tax_label: "消費税", separator: "：", align: "right" }),
      block("statement", "text", { text: "上記金額を正に領収いたしました。", align: "center", size: "s" }),
      block("sp2", "spacer", { height: 16 }),
      block("proviso", "receipt_proviso", { prefix: "但", suffix: "として", underline: "solid" }),
      block("stamp", "stamp_box", { label: "担当印", size: 80, align: "right" }),
      block("issuer", "issuer", { name: "", align: "center", bold: true }),
      block("meta", "receipt_meta", { show_date: true, show_order: true }, true),
    ],
    { ...CIARA_STYLE, customCss: CIARA_LOGO_CSS },
  );
}

/** 精算レシート（Ciara 風・仮）: gift-receipt.liquid が読むメタフィールドの順 */
export function ciaraSettlementLayout(): ReceiptLayout {
  return layout(
    "settlement",
    [
      ciaraLogo(),
      block("title", "heading", { text: "{{ settlement.title }}", size: "l" }),
      block("meta", "settlement_meta", { show_as_of: true }),
      block("hr1", "divider", { style: "thick" }),
      row("net", "net_sales", "純売上", { bold: true }),
      row("total", "total", "総売上"),
      row("disc", "discounts", "割引"),
      row("points", "vip_points_used", "ポイント利用", { hide_zero: true }),
      row("tax", "tax", "消費税"),
      row("orders", "order_count", "件数", { unit: "件" }),
      row("refunds", "refund_count", "返金件数", { unit: "件" }),
      row("items", "item_count", "点数", { unit: "点" }),
      row("refund", "refund_total", "返金額"),
      row("voucher", "voucher_change", "商品券釣有り差額", { hide_zero: true }),
      row("cash_delta", "receipt_cash_manual_delta", "領収書現金調整", { hide_zero: true }),
      block("hr2", "divider", { style: "thick" }),
      block("payments", "settlement_payments", { heading: "支払方法別" }),
      block("stamp", "stamp_box", { label: "確認印", align: "right" }),
    ],
    { ...CIARA_STYLE, customCss: CIARA_LOGO_CSS },
  );
}

export type LayoutPreset = { id: string; label: string; kinds: ReceiptKind[]; build: (kind: ReceiptKind) => ReceiptLayout };

export const LAYOUT_PRESETS: LayoutPreset[] = [
  { id: "standard", label: "標準", kinds: ["settlement", "sales", "gift", "receipt"], build: defaultLayout },
  { id: "ciara-sales", label: "Ciara 風", kinds: ["sales"], build: () => ciaraSalesLayout() },
  { id: "ciara-receipt", label: "Ciara 風", kinds: ["receipt"], build: () => ciaraReceiptLayout() },
  { id: "ciara-settlement", label: "Ciara 風（仮）", kinds: ["settlement"], build: () => ciaraSettlementLayout() },
];

export function presetsForKind(kind: ReceiptKind): LayoutPreset[] {
  return LAYOUT_PRESETS.filter((p) => p.kinds.includes(kind));
}
