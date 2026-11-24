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
      href: "/app/receipt-layouts/settlement",
      linkLabel: "精算・点検のデザイン",
    },
    {
      document: "点検",
      ...shared,
      href: "/app/receipt-layouts/settlement",
      linkLabel: "精算・点検のデザイン",
    },
    {
      document: "領収書",
      ...shared,
      href: "/app/receipt-layouts/receipt",
      linkLabel: "領収書のデザイン",
    },
    {
      document: "販売レシート",
      settingName: "販売・ギフトの基本設定の用紙幅",
      widthMm: input.salesWidthMm,
      href: "/app/receipt-layouts/sales",
      linkLabel: "販売・ギフトの基本設定",
      shared: false,
    },
  ];
}

/** 80mm を 100% としたときの帯の幅。管理画面の比率表示用。 */
export function paperStripPercent(widthMm: PaperMm): number {
  return Math.round((widthMm / 80) * 1000) / 10;
}
