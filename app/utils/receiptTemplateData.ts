/** 領収書テンプレートのデフォルト値（要件 §9.2） */
export const DEFAULT_TEMPLATE = {
  // §9.2.1 基本情報
  receiptTemplateName: "",
  logoUrl: null as string | null,
  companyName: "",
  postalCode: "",
  address: "",
  address2: "",
  phone: "",
  // §9.2.2 表示項目
  showIssueDate: true,
  showOrderName: true,
  showLocationName: true,
  showCustomerName: true,
  showProviso: true,
  showAmount: true,
  showTaxNote: true,
  showReissueMark: true,
  // §9.2.3 デフォルト値
  defaultProviso: "お買上品代として",
  defaultRecipientSuffix: "様",
  // §9.2.4 レイアウト（MVP はシンプルな値）
  headerAlignment: "center" as "left" | "center" | "right",
  logoPosition: "top" as "top" | "inline",
  companyInfoPosition: "bottom" as "top" | "bottom",
  amountEmphasisMode: "normal" as "normal" | "emphasis",
  bodySpacing: "normal" as "compact" | "normal" | "relaxed",
  // §9.2.5 文言
  receiptTitle: "領収書",
  reissueLabel: "再発行",
  taxNoteLabel: "（税込）",
  currencyPrefix: "¥",
  // 後方互換のエイリアス（既存データ用）
  showOrderNumber: true,
  showDate: true,
};

export type ReceiptTemplateData = typeof DEFAULT_TEMPLATE;

/** 既存 templateJson（旧キー含む）を §9.2 の型に正規化（管理画面 loader でも使用） */
export function normalizeTemplateData(partial: Record<string, unknown> | null): ReceiptTemplateData {
  const data = { ...DEFAULT_TEMPLATE, ...partial } as ReceiptTemplateData;
  if (partial && "showOrderNumber" in partial) data.showOrderName = !!partial.showOrderNumber;
  if (partial && "showDate" in partial) data.showIssueDate = !!partial.showDate;
  data.showOrderNumber = data.showOrderName;
  data.showDate = data.showIssueDate;
  return data;
}
