/** 管理画面上の用紙幅と、どの帳票がどの設定を読むかの対応。印字 HTML はここでは作らない。 */

export type PaperMm = 58 | 80;

export type PaperWidthUse = {
  document: string;
  settingName: string;
  widthMm: PaperMm;
  href: string;
  linkLabel: string;
  shared: boolean;
};

export function parseSharedPaperWidth(value: string | null | undefined): PaperMm {
  return value === "58mm" || value === "58" ? 58 : 80;
}

export function parseSalesPaperWidth(value: unknown): PaperMm {
  return value === 58 || value === "58" || value === "58mm" ? 58 : 80;
}

export function paperWidthUses(input: {
  sharedWidthMm: PaperMm;
  salesWidthMm: PaperMm;
}): PaperWidthUse[] {
  const shared = {
    settingName: "印字設定の用紙幅",
    widthMm: input.sharedWidthMm,
    shared: true,
  };
  return [
    {
      document: "精算",
      ...shared,
      href: "/app/settlement-print-layout",
      linkLabel: "精算印字プレビュー",
    },
    {
      document: "点検",
      ...shared,
      href: "/app/settlement-print-layout",
      linkLabel: "精算印字プレビュー",
    },
    {
      document: "領収書",
      ...shared,
      href: "/app/receipt-print-layout",
      linkLabel: "領収書印字プレビュー",
    },
    {
      document: "販売レシート",
      settingName: "販売レシート設定の用紙幅",
      widthMm: input.salesWidthMm,
      href: "/app/sales-receipt-settings",
      linkLabel: "販売レシート設定",
      shared: false,
    },
  ];
}

/** 80mm を 100% としたときの帯の幅。管理画面の比率表示用。 */
export function paperStripPercent(widthMm: PaperMm): number {
  return Math.round((widthMm / 80) * 1000) / 10;
}
