/**
 * レシートのレイアウト（4 種）の保存形式
 *
 * 1 レイアウト = 1 種類のレシート（精算・点検／販売／ギフト／領収書）。
 * - mode "blocks": ブロックの並び（並べ替え・表示切替・文言）から印字 HTML を作る
 * - mode "code":   テンプレートのコード（Liquid）を直接書く上級者向け
 * どちらも receiptLayoutRender.ts の同じレンダラで HTML にするので、プレビューと印字が一致する。
 *
 * 保存先は AppSetting（key = receipt_layout_v1_<kind>）。DB の形は変えない。
 */

export const RECEIPT_KINDS = ["settlement", "sales", "gift", "receipt"] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

export const RECEIPT_KIND_LABELS: Record<ReceiptKind, string> = {
  settlement: "精算・点検レシート",
  sales: "販売レシート",
  gift: "ギフトレシート",
  receipt: "領収書",
};

export function isReceiptKind(v: unknown): v is ReceiptKind {
  return typeof v === "string" && (RECEIPT_KINDS as readonly string[]).includes(v);
}

export function receiptLayoutSettingKey(kind: ReceiptKind): string {
  return `receipt_layout_v1_${kind}`;
}

export type BlockSettingValue = string | number | boolean;

export type LayoutBlock = {
  /** 並べ替え・編集の目印（レイアウトの中で一意） */
  id: string;
  /** receiptLayoutBlocks.ts の BLOCK_DEFS のキー */
  type: string;
  hidden?: boolean;
  settings: Record<string, BlockSettingValue>;
};

export type FontFamily = "sans" | "serif" | "mono";

export type LayoutStyle = {
  /** 本文の文字の大きさ（px） */
  fontSizePx: number;
  lineHeight: number;
  fontWeight: 400 | 600 | 700;
  fontFamily: FontFamily;
  /** 余白（px） */
  paddingPx: number;
  /** ブロックの CSS に足す（上級者向け） */
  customCss: string;
};

export type ReceiptLayout = {
  version: 1;
  kind: ReceiptKind;
  mode: "blocks" | "code";
  paperWidthMm: 58 | 80;
  style: LayoutStyle;
  blocks: LayoutBlock[];
  /** mode "code" のときのテンプレート（HTML 文書全体） */
  code: string;
};

export const DEFAULT_LAYOUT_STYLE: LayoutStyle = {
  fontSizePx: 13,
  lineHeight: 1.35,
  fontWeight: 400,
  fontFamily: "sans",
  paddingPx: 8,
  customCss: "",
};

/** 入力の上限（保存・描画の両方で守る） */
export const LAYOUT_LIMITS = {
  maxBlocks: 60,
  maxTextLength: 2000,
  maxCodeLength: 100_000,
  maxCssLength: 20_000,
  /** 画像の URL（data:image を含む） */
  maxUrlLength: 200_000,
  fontSizePx: { min: 8, max: 32 },
  lineHeight: { min: 1, max: 2.5 },
  paddingPx: { min: 0, max: 40 },
} as const;

export const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * キーの順をそろえた形にする。画面が送る値・サーバーが返す値を同じ文字列にし、
 * 保存したあとに保存の帯が出直さないようにする。
 */
export function canonicalLayout(l: ReceiptLayout): ReceiptLayout {
  return {
    version: 1,
    kind: l.kind,
    mode: l.mode,
    paperWidthMm: l.paperWidthMm,
    style: {
      fontSizePx: l.style.fontSizePx,
      lineHeight: l.style.lineHeight,
      fontWeight: l.style.fontWeight,
      fontFamily: l.style.fontFamily,
      paddingPx: l.style.paddingPx,
      customCss: l.style.customCss,
    },
    blocks: l.blocks.map((b) => ({ id: b.id, type: b.type, hidden: b.hidden === true, settings: Object.fromEntries(Object.keys(b.settings).sort().map((k) => [k, b.settings[k]])) })),
    code: l.code,
  };
}
