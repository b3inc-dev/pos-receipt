/**
 * 印字用紙幅の中立キー（paperWidthMm）とレガシー cloudprntPaperWidth の同期。
 * CloudPRNT 専用キー名が Printing HTML にも食い込んでいたため、読み取りは mm を正とする。
 */

export type PrintPaperWidthMm = 58 | 80;

export function resolvePrintPaperWidthMm(settings: {
  paperWidthMm?: PrintPaperWidthMm | null;
  cloudprntPaperWidth?: string | null;
} | null | undefined): PrintPaperWidthMm {
  if (settings?.paperWidthMm === 58 || settings?.paperWidthMm === 80) {
    return settings.paperWidthMm;
  }
  return settings?.cloudprntPaperWidth === "58mm" ? 58 : 80;
}

export function syncPrintPaperWidthFields(widthMm: PrintPaperWidthMm): {
  paperWidthMm: PrintPaperWidthMm;
  cloudprntPaperWidth: string;
} {
  return {
    paperWidthMm: widthMm,
    cloudprntPaperWidth: widthMm === 58 ? "58mm" : "80mm",
  };
}
