/**
 * 印字用 HTML レンダラ（販売・精算・領収書で共有）
 * Shopify Printing API は text/html をレシートプリンタへ直送する。
 * プレビューと印字 HTML を同一関数で生成し、見た目の差分を防ぐ。
 */

export type PrintAttr = { key: string; value: string };

export type SalesReceiptLineItem = {
  title: string;
  variantTitle?: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  sku?: string;
  customAttributes?: PrintAttr[];
};

export type SalesReceiptPrintModel = {
  kind: "sales";
  shopName?: string;
  orderName: string;
  createdAtLabel: string;
  locationName?: string;
  currency: string;
  subtotal: number;
  tax: number;
  discounts: number;
  total: number;
  lineItems: SalesReceiptLineItem[];
  orderAttributes?: PrintAttr[];
  payments?: { label: string; amount: number }[];
  footerNote?: string;
  showOrderAttributes: boolean;
  showLineAttributes: boolean;
  /** Admin layoutJson — プレビューと実印字で同一適用 */
  showSku?: boolean;
  showPayments?: boolean;
  showLocation?: boolean;
  paperWidthMm: 58 | 80;
};

export type SettlementReceiptPrintModel = {
  kind: "settlement";
  title: string;
  targetDate: string;
  locationName: string;
  currency: string;
  total: number;
  netSales: number;
  tax: number;
  discounts: number;
  refundTotal: number;
  orderCount: number;
  refundCount: number;
  itemCount: number;
  voucherChangeAmount: number;
  paymentSections: { label: string; net: number; txCount?: number; refund?: number; refundCount?: number }[];
  /** preferences C: 販売レシート設定と同じ ON/OFF */
  showOrderAttributes: boolean;
  showLineAttributes: boolean;
  /** 対象注文の属性サマリ（注文まとめて） */
  orderAttributes?: PrintAttr[];
  /** 対象注文の商品別属性サマリ */
  lineAttributes?: PrintAttr[];
  paperWidthMm: 58 | 80;
};

export type GiftReceiptPrintModel = {
  kind: "receipt";
  title: string;
  recipientName: string;
  proviso: string;
  amount: number;
  currency: string;
  issueDate: string;
  orderName?: string;
  locationName?: string;
  companyName?: string;
  address?: string;
  phone?: string;
  showOrderNumber?: boolean;
  showDate?: boolean;
  /** preferences C: 販売レシート設定と同じ ON/OFF */
  showOrderAttributes: boolean;
  showLineAttributes: boolean;
  orderAttributes?: PrintAttr[];
  lineAttributes?: PrintAttr[];
  paperWidthMm: 58 | 80;
};

export type PrintReceiptModel =
  | SalesReceiptPrintModel
  | SettlementReceiptPrintModel
  | GiftReceiptPrintModel;

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function yen(n: number, currency = "JPY"): string {
  const v = Number(n) || 0;
  if (currency === "JPY") return `¥${Math.round(v).toLocaleString("ja-JP")}`;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${currency}`;
}

function attrsHtml(attrs: PrintAttr[] | undefined, indent = false): string {
  if (!attrs?.length) return "";
  const pad = indent ? "padding-left:12px;" : "";
  return attrs
    .filter((a) => String(a.key ?? "").trim() || String(a.value ?? "").trim())
    .map(
      (a) =>
        `<div class="attr" style="${pad}">${esc(a.key)}${a.key ? ": " : ""}${esc(a.value)}</div>`,
    )
    .join("");
}

function shell(widthMm: 58 | 80, body: string, title: string): string {
  const maxW = widthMm === 58 ? 384 : 576;
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 8px;
    font-family: "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif;
    font-size: 13px;
    line-height: 1.35;
    color: #000;
    background: #fff;
    width: ${maxW}px;
    max-width: 100%;
  }
  h1 { font-size: 16px; margin: 0 0 8px; text-align: center; }
  .row { display: flex; justify-content: space-between; gap: 8px; margin: 2px 0; }
  .muted { color: #333; font-size: 12px; }
  .attr { font-size: 11px; color: #222; margin: 1px 0; }
  .hr { border: 0; border-top: 1px dashed #000; margin: 8px 0; }
  .item-title { font-weight: 600; }
  .total { font-size: 15px; font-weight: 700; margin-top: 4px; }
  .center { text-align: center; }
  .footer { margin-top: 12px; font-size: 11px; text-align: center; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function renderSales(m: SalesReceiptPrintModel): string {
  const showSku = m.showSku === true;
  const showPayments = m.showPayments !== false;
  const showLocation = m.showLocation !== false;

  const lines = m.lineItems
    .map((li) => {
      const name = li.variantTitle ? `${li.title} (${li.variantTitle})` : li.title;
      const skuLine =
        showSku && String(li.sku ?? "").trim()
          ? `<div class="muted" style="padding-left:0;">SKU: ${esc(li.sku)}</div>`
          : "";
      const lineAttrs =
        m.showLineAttributes && li.customAttributes?.length
          ? attrsHtml(li.customAttributes, true)
          : "";
      return `<div class="item">
  <div class="item-title">${esc(name)}</div>
  ${skuLine}
  <div class="row muted"><span>×${esc(li.quantity)} @ ${esc(yen(li.unitPrice, m.currency))}</span><span>${esc(yen(li.lineTotal, m.currency))}</span></div>
  ${lineAttrs}
</div>`;
    })
    .join("");

  const orderAttrs =
    m.showOrderAttributes && m.orderAttributes?.length
      ? `<div class="hr"></div><div class="muted">注文属性</div>${attrsHtml(m.orderAttributes)}`
      : "";

  const payments = showPayments
    ? (m.payments ?? [])
        .map(
          (p) =>
            `<div class="row"><span>${esc(p.label)}</span><span>${esc(yen(p.amount, m.currency))}</span></div>`,
        )
        .join("")
    : "";

  const locationBlock =
    showLocation && m.locationName
      ? `<div class="center muted">${esc(m.locationName)}</div>`
      : "";

  const body = `
<h1>${esc(m.shopName || "レシート")}</h1>
<div class="center muted">${esc(m.createdAtLabel)}</div>
${locationBlock}
<div class="center muted">${esc(m.orderName)}</div>
<div class="hr"></div>
${lines}
<div class="hr"></div>
<div class="row"><span>小計</span><span>${esc(yen(m.subtotal, m.currency))}</span></div>
${m.discounts ? `<div class="row"><span>割引</span><span>-${esc(yen(m.discounts, m.currency))}</span></div>` : ""}
<div class="row"><span>税</span><span>${esc(yen(m.tax, m.currency))}</span></div>
<div class="row total"><span>合計</span><span>${esc(yen(m.total, m.currency))}</span></div>
${payments ? `<div class="hr"></div>${payments}` : ""}
${orderAttrs}
${m.footerNote ? `<div class="footer">${esc(m.footerNote)}</div>` : ""}
`;
  return shell(m.paperWidthMm, body, `販売レシート ${m.orderName}`);
}

function renderSettlement(m: SettlementReceiptPrintModel): string {
  const payments = m.paymentSections
    .map((s) => {
      const extra =
        s.refund && s.refund > 0
          ? ` 返金${s.refundCount ?? 0}件 ${yen(s.refund, m.currency)}`
          : "";
      return `<div class="row"><span>${esc(s.label)}</span><span>${esc(yen(s.net, m.currency))} (${esc(s.txCount ?? 0)}件)${esc(extra)}</span></div>`;
    })
    .join("");

  const body = `
<h1>${esc(m.title)}</h1>
<div class="row"><span>日付</span><span>${esc(m.targetDate)}</span></div>
<div class="row"><span>ロケーション</span><span>${esc(m.locationName)}</span></div>
<div class="hr"></div>
<div class="row"><span>総売上</span><span>${esc(yen(m.total, m.currency))}</span></div>
<div class="row"><span>純売上</span><span>${esc(yen(m.netSales, m.currency))}</span></div>
<div class="row"><span>消費税</span><span>${esc(yen(m.tax, m.currency))}</span></div>
<div class="row"><span>割引</span><span>${esc(yen(m.discounts, m.currency))}</span></div>
<div class="row"><span>返金</span><span>${esc(yen(m.refundTotal, m.currency))}</span></div>
<div class="row"><span>件数</span><span>${esc(m.orderCount)}件 (返金${esc(m.refundCount)}件)</span></div>
<div class="row"><span>点数</span><span>${esc(m.itemCount)}点</span></div>
${
  m.voucherChangeAmount > 0
    ? `<div class="row"><span>商品券釣有り差額</span><span>${esc(yen(m.voucherChangeAmount, m.currency))}</span></div>`
    : ""
}
<div class="hr"></div>
${payments}
${
  m.showOrderAttributes && m.orderAttributes?.length
    ? `<div class="hr"></div><div class="muted">注文属性</div>${attrsHtml(m.orderAttributes)}`
    : ""
}
${
  m.showLineAttributes && m.lineAttributes?.length
    ? `<div class="hr"></div><div class="muted">商品属性</div>${attrsHtml(m.lineAttributes)}`
    : ""
}
`;
  return shell(m.paperWidthMm, body, m.title);
}

function renderGiftReceipt(m: GiftReceiptPrintModel): string {
  const orderAttrs =
    m.showOrderAttributes && m.orderAttributes?.length
      ? `<div class="hr"></div><div class="muted">注文属性</div>${attrsHtml(m.orderAttributes)}`
      : "";
  const lineAttrs =
    m.showLineAttributes && m.lineAttributes?.length
      ? `<div class="hr"></div><div class="muted">商品属性</div>${attrsHtml(m.lineAttributes)}`
      : "";
  const body = `
<h1>${esc(m.title || "領　収　書")}</h1>
${m.companyName ? `<div class="center">${esc(m.companyName)}</div>` : ""}
${m.address ? `<div class="center muted">${esc(m.address)}</div>` : ""}
${m.phone ? `<div class="center muted">${esc(m.phone)}</div>` : ""}
<div class="hr"></div>
<div class="row"><span>宛名</span><span>${esc(m.recipientName || "　")}</span></div>
<div class="row total"><span>金額</span><span>${esc(yen(m.amount, m.currency))}</span></div>
<div class="row"><span>但し</span><span>${esc(m.proviso)}</span></div>
${m.showDate !== false ? `<div class="row"><span>発行日</span><span>${esc(m.issueDate)}</span></div>` : ""}
${m.showOrderNumber !== false && m.orderName ? `<div class="row"><span>注文</span><span>${esc(m.orderName)}</span></div>` : ""}
${m.locationName ? `<div class="row"><span>店舗</span><span>${esc(m.locationName)}</span></div>` : ""}
${orderAttrs}
${lineAttrs}
`;
  return shell(m.paperWidthMm, body, "領収書");
}

/** プレビュー・印字で同一 HTML を返す */
export function renderPrintReceiptHtml(model: PrintReceiptModel): string {
  switch (model.kind) {
    case "sales":
      return renderSales(model);
    case "settlement":
      return renderSettlement(model);
    case "receipt":
      return renderGiftReceipt(model);
    default: {
      const _exhaustive: never = model;
      return String(_exhaustive);
    }
  }
}

/** プレーンテキスト精算レシートを HTML モデルへ（既存テキスト生成と数値整合） */
export function settlementPreviewToPrintModel(
  preview: {
    targetDate: string;
    locationName: string;
    currency?: string;
    total: number;
    netSales: number;
    tax: number;
    discounts: number;
    refundTotal: number;
    orderCount: number;
    refundCount: number;
    itemCount: number;
    voucherChangeAmount: number;
    paymentSections: {
      label: string;
      net: number;
      txCount?: number;
      refund?: number;
      refundCount?: number;
    }[];
  },
  opts?: {
    isInspection?: boolean;
    paperWidthMm?: 58 | 80;
    showOrderAttributes?: boolean;
    showLineAttributes?: boolean;
    orderAttributes?: PrintAttr[];
    lineAttributes?: PrintAttr[];
  },
): SettlementReceiptPrintModel {
  return {
    kind: "settlement",
    title: opts?.isInspection ? "【点検レシート】" : "【精算レシート】",
    targetDate: preview.targetDate,
    locationName: preview.locationName,
    currency: preview.currency ?? "JPY",
    total: preview.total,
    netSales: preview.netSales,
    tax: preview.tax,
    discounts: preview.discounts,
    refundTotal: preview.refundTotal,
    orderCount: preview.orderCount,
    refundCount: preview.refundCount,
    itemCount: preview.itemCount,
    voucherChangeAmount: preview.voucherChangeAmount,
    paymentSections: preview.paymentSections,
    showOrderAttributes: opts?.showOrderAttributes === true,
    showLineAttributes: opts?.showLineAttributes === true,
    orderAttributes: opts?.orderAttributes,
    lineAttributes: opts?.lineAttributes,
    paperWidthMm: opts?.paperWidthMm ?? 80,
  };
}
