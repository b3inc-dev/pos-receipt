/**
 * レシートの「再印字」「再精算」の印（T の依頼 2026-11-24）
 *
 * - 再印字: そのレシートを一度印刷できたあと（POS が印刷を受け付けたあと）にもう一度印刷したとき。
 *   発行した画面で押し直したときも、履歴から印刷したときも同じ（T の決定: 一度印刷できた後は全部）。
 *   点検レシートには付けない（確認のために何度も出すため。T 2026-11-24）。
 *   精算（Settlement.printedAt）、領収書・販売レシート・ギフトレシート（PrintRecord）で見る。
 * - 再精算: 確定済みの日を「今の数で再確定する」で確定し直してできた精算。発行したときに
 *   精算の記録（paymentSectionsJson の snapshot.resettlement）に残すので、あとで印刷し直しても消えない。
 * - どれも店ごとに管理画面の印字設定でオン／オフと文言を選ぶ。初期値はオフ（今までの印字のまま）。
 * - 金額・件数・精算の数え方・Shopify への書き込みには関係しない（紙に出す飾りだけ）。
 */
import type { ReceiptLayout } from "./receiptLayoutSchema";

export const PRINT_MARK_SETTINGS_KEY = "print_marks_v1";
export const DEFAULT_REPRINT_MARK_TEXT = "再印字";
export const DEFAULT_RESETTLEMENT_MARK_TEXT = "再精算";
export const PRINT_MARK_TEXT_MAX = 20;

/** 印を出すレシートの種類（販売とギフトは注文 1 件ごとに別に数える） */
export type PrintMarkKind = "settlement" | "receipt" | "sales" | "gift";

export type PrintMarkSettings = {
  /** 精算レシートを印刷し直したとき（点検は確認のために何度も出すので印を付けない。T 2026-11-24） */
  settlementReprint: boolean;
  /** 領収書を印刷し直したとき */
  receiptReprint: boolean;
  /** 販売レシート・ギフトレシートを印刷し直したとき */
  salesReprint: boolean;
  /** 確定し直した精算（再精算） */
  resettlement: boolean;
  reprintText: string;
  resettlementText: string;
};

export const DEFAULT_PRINT_MARK_SETTINGS: PrintMarkSettings = {
  settlementReprint: false,
  receiptReprint: false,
  salesReprint: false,
  resettlement: false,
  reprintText: DEFAULT_REPRINT_MARK_TEXT,
  resettlementText: DEFAULT_RESETTLEMENT_MARK_TEXT,
};

/** 文言の欄: 改行を空白にし、前後の空白を除き、長すぎる分は切る。空なら既定の文言 */
export function normalizeMarkText(raw: unknown, fallback: string): string {
  const s = String(raw ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, PRINT_MARK_TEXT_MAX);
  return s || fallback;
}

/** 保存した設定（無い・古い・壊れている）を読む。わからない値はオフ */
export function normalizePrintMarkSettings(raw: unknown): PrintMarkSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    settlementReprint: o.settlementReprint === true,
    receiptReprint: o.receiptReprint === true,
    salesReprint: o.salesReprint === true,
    resettlement: o.resettlement === true,
    reprintText: normalizeMarkText(o.reprintText, DEFAULT_REPRINT_MARK_TEXT),
    resettlementText: normalizeMarkText(o.resettlementText, DEFAULT_RESETTLEMENT_MARK_TEXT),
  };
}

function reprintOn(kind: PrintMarkKind, s: PrintMarkSettings): boolean {
  if (kind === "settlement") return s.settlementReprint;
  if (kind === "receipt") return s.receiptReprint;
  return s.salesReprint;
}

/** 紙に出す印の一覧（再精算 → 再印字の順）。出さないときは空 */
export function printMarksFor(
  kind: PrintMarkKind,
  state: { isReprint: boolean; isResettlement?: boolean; isInspection?: boolean },
  settings: PrintMarkSettings,
): string[] {
  const marks: string[] = [];
  // 点検レシートは確認のために何度も出すので、再印字・再精算の印は付けない（T 2026-11-24）
  if (kind === "settlement" && state.isInspection) return marks;
  if (kind === "settlement" && state.isResettlement && settings.resettlement) marks.push(settings.resettlementText);
  if (state.isReprint && reprintOn(kind, settings)) marks.push(settings.reprintText);
  return marks;
}

/** 印を 1 行にした文（「再精算・再印字」） */
export function printMarkLine(marks: string[]): string {
  return marks.join("・");
}

/** 印字の値（レイアウトの Liquid）に足す分 */
export function printMarkTemplateValues(marks: string[], isReprint: boolean) {
  return { is_reprint: isReprint, print_marks: [...marks], print_mark_text: printMarkLine(marks) };
}

/**
 * レイアウトが自分で印の場所を決めているか。
 * ブロックなら「再印字・再精算の印」ブロック（隠していないもの）、コードなら print_mark などの値を使っているとき。
 * 決めていなければ、印はレシートのいちばん上に自動で出す。
 */
export function layoutPlacesPrintMarks(layout: Pick<ReceiptLayout, "mode" | "blocks" | "code">): boolean {
  if (layout.mode === "code") return /\b(print_mark|print_marks|print_mark_text|is_reprint|is_resettlement)\b/.test(layout.code ?? "");
  return (layout.blocks ?? []).some((b) => b.type === "print_marks" && !b.hidden);
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 印の HTML（太字・中央・四角で囲む）。どの印字の道でも同じ見た目 */
export function printMarkHtml(marks: string[]): string {
  if (marks.length === 0) return "";
  return `<div class="print-mark" style="text-align:center;margin:0 0 6px"><span style="display:inline-block;border:2px solid #000;padding:2px 10px;font-weight:700;font-size:1.25em;letter-spacing:0.1em">${escHtml(printMarkLine(marks))}</span></div>`;
}

/** <body> のすぐ後ろ（レシートのいちばん上）に印を入れる。<body> が無ければ先頭に付ける */
export function insertPrintMarkAtTop(html: string, marks: string[]): string {
  const mark = printMarkHtml(marks);
  if (!mark) return html;
  const m = /<body(\s[^>]*)?>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + mark + html.slice(m.index + m[0].length);
  return mark + html;
}

/** レイアウトで作った HTML に、レイアウトが場所を決めていないときだけ上に印を入れる */
export function applyPrintMarksToLayoutHtml(
  html: string,
  layout: Pick<ReceiptLayout, "mode" | "blocks" | "code">,
  marks: string[],
): string {
  if (marks.length === 0 || layoutPlacesPrintMarks(layout)) return html;
  return insertPrintMarkAtTop(html, marks);
}

/** 印刷を受け付けた記録（PrintRecord）を付けるレシートの種類 */
export const PRINT_RECORD_KINDS = ["receipt", "sales", "gift"] as const;
export type PrintRecordKind = (typeof PRINT_RECORD_KINDS)[number];

export function isPrintRecordKind(v: unknown): v is PrintRecordKind {
  return typeof v === "string" && (PRINT_RECORD_KINDS as readonly string[]).includes(v);
}

/** 販売・ギフトの注文の id は数字だけにそろえる（gid でも数字でも同じ記録） */
export function printRecordTargetId(kind: PrintRecordKind, id: string): string {
  const s = String(id ?? "").trim();
  if (kind === "receipt") return s;
  return s.replace(/^gid:\/\/shopify\/Order\//, "");
}
