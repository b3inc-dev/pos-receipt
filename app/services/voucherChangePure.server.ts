/**
 * 商品券釣有り差額（商品券のお釣り）の決め方 — 純関数
 *
 * 管理画面「商品券設定」（appSettings `voucher_settings`）を精算に効かせる。
 * - 機能 OFF … 自動も手入力も数えない
 * - 自動判定 OFF … 注文から見つけた分（現金の預かり超過・注文メモの額面）を数えない
 * - 手動調整 OFF … POS「商品券調整」の登録を数えない（登録も API で止める）
 * - 注文メモから額面を読む OFF … メモの額面は見ない（現金の預かり超過は見る）
 * - 判定優先順位 … 同じ注文に自動と手入力の両方があるとき、片方だけ数える（二重計上の防止）
 * - 精算に反映 OFF … 精算の「商品券釣有り差額」を 0 にする
 */
import type { VoucherSettings } from "../utils/appSettings.server";

/** 商品券設定の「保存の版」。これより前に保存した設定は、配線前の画面で保存したもの */
export const VOUCHER_SETTINGS_VERSION = 2;

/** 注文の自動判定のルール（settlementAggregatePure に渡す） */
export interface VoucherDetectionRules {
  /** 自動判定を数えるか（false なら voucherChangeByOrder は空） */
  autoDetectionEnabled: boolean;
  /** 注文メモから額面を読むか */
  noteParseEnabled: boolean;
  /** 注文メモ・支払方法名で商品券とみなす言葉（初めは「商品券」） */
  keyword: string;
  /** 額面を読む正規表現（1 番目のかっこが金額）。null なら `<言葉>\s*([0-9]+)\s*(?:円|えん)?` */
  noteRegex: RegExp | null;
}

export const DEFAULT_VOUCHER_KEYWORD = "商品券";
/** 読取用正規表現の長さの上限（重い式で集計が止まらないように） */
export const VOUCHER_NOTE_REGEX_MAX_LENGTH = 100;

export const DEFAULT_VOUCHER_DETECTION_RULES: VoucherDetectionRules = {
  autoDetectionEnabled: true,
  noteParseEnabled: true,
  keyword: DEFAULT_VOUCHER_KEYWORD,
  noteRegex: null,
};

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 読取用正規表現の文字列を確かめる。空なら null（初めの式を使う）。不正・かっこ無しはエラー文 */
export function compileVoucherNoteRegex(src: string | null | undefined): { regex: RegExp | null; error: string | null } {
  const s = String(src ?? "").trim();
  if (!s) return { regex: null, error: null };
  if (s.length > VOUCHER_NOTE_REGEX_MAX_LENGTH) {
    return { regex: null, error: `読取用正規表現は ${VOUCHER_NOTE_REGEX_MAX_LENGTH} 文字までにしてください` };
  }
  let re: RegExp;
  try {
    re = new RegExp(s);
  } catch {
    return { regex: null, error: "読取用正規表現の書き方が正しくありません" };
  }
  // かっこ（金額の部分）が 1 つ以上あるか: 空文字に「何にも当たらない」選択肢を足して数える
  const groups = new RegExp(`${s}|`).exec("")?.length ?? 1;
  if (groups < 2) {
    return { regex: null, error: "読取用正規表現に、金額の部分を ( ) で 1 つ入れてください" };
  }
  return { regex: re, error: null };
}

/**
 * 保存された商品券設定を精算で使う形に直す。
 *
 * 版の無い設定（まだ保存していない店・配線前の画面で保存した店）は `legacy: true` にし、
 * 項目は全部初めの値として読む。精算は今までどおり（自動判定＋手入力を両方足す・POS の登録は止めない）。
 * 新しい画面で一度保存すると版が付き、保存した値と二重計上の防止が効き始める。
 * こうしておくと main に入れた時点ではどの店の数も変わらず、店ごとに（Ciara から）切り替えられる。
 */
export function resolveVoucherSettings(
  saved: (Partial<VoucherSettings> & { settingsVersion?: number }) | null | undefined,
  defaults: VoucherSettings,
): VoucherSettings & { settingsVersion: number; legacy: boolean } {
  const version = Number(saved?.settingsVersion ?? 0);
  if (!saved || !(version >= VOUCHER_SETTINGS_VERSION)) {
    return { ...defaults, settingsVersion: version, legacy: true };
  }
  return { ...defaults, ...saved, settingsVersion: version, legacy: false };
}

export function voucherDetectionRulesFromSettings(s: VoucherSettings): VoucherDetectionRules {
  const keyword = String(s.voucherDefaultLabel ?? "").trim() || DEFAULT_VOUCHER_KEYWORD;
  const { regex } = compileVoucherNoteRegex(s.voucherNoteParseRegex);
  return {
    autoDetectionEnabled: Boolean(s.voucherFeatureEnabled && s.voucherAutoDetectionEnabled),
    noteParseEnabled: Boolean(s.voucherNoteParseEnabled),
    keyword,
    noteRegex: regex,
  };
}

/** 全角数字・読点を除いて半角化（GAS z2hDigits） */
function z2hDigits(input: string): string {
  let s = "";
  for (const ch of String(input ?? "")) {
    const code = ch.charCodeAt(0);
    s += code >= 0xff10 && code <= 0xff19 ? String.fromCharCode(code - 0xfee0) : ch;
  }
  return s.replace(/[，、,]/g, "");
}

/** 注文メモから額面を読む（GAS parseVoucherFaceFromNote。言葉と式は設定から） */
export function parseVoucherFaceFromNoteWithRules(
  note: string | null | undefined,
  rules: VoucherDetectionRules,
): number {
  if (!rules.noteParseEnabled) return 0;
  const s = z2hDigits(note ?? "");
  const re =
    rules.noteRegex ?? new RegExp(`${escapeRegExp(rules.keyword)}\\s*([0-9]+)\\s*(?:円|えん)?`);
  const m = s.match(re);
  const n = m ? Number(z2hDigits(String(m[1] ?? "")).replace(/[^0-9.]/g, "")) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 商品券として額面をそのまま数える支払方法名（初めの言葉なら GAS と同じ 3 つ） */
export function voucherAppliedGatewayNames(keyword: string): string[] {
  return [`${keyword}釣有り`, `${keyword}釣無し`, keyword];
}

/** 注文 ID を比べるための形（gid でも数字でも末尾の数字） */
export function normalizeOrderKey(id: string | null | undefined): string {
  const s = String(id ?? "").trim();
  const m = s.match(/(\d+)(?:\?.*)?$/);
  return m ? m[1] : s;
}

export interface ManualVoucherEvent {
  id?: string;
  sourceOrderId: string;
  voucherChangeAmount: { toString(): string } | number | null;
}

export interface VoucherChangeResolution {
  /** 精算に出す「商品券釣有り差額」 */
  total: number;
  autoTotal: number;
  manualTotal: number;
  /** 実際に数えた手入力（精算プレビューの一覧用） */
  appliedManual: ManualVoucherEvent[];
  /** 優先順位で数えなかった注文（自動を外した／手入力を外した） */
  skippedAutoOrderKeys: string[];
  skippedManualOrderKeys: string[];
  /** 優先順位で外した額（自動の分・手入力の分） */
  skippedAutoAmount: number;
  skippedManualAmount: number;
  /** 版の無い設定で、今までどおり両方足したとき true */
  legacy: boolean;
}

/**
 * 自動判定（注文ごと）と手入力（POS 商品券調整）を合わせて差額を決める。
 * 同じ注文に両方あれば、判定優先順位の方だけを数える。
 * 手入力は登録した日の精算に、自動は取引の日の精算に入るため、日をまたぐ注文は突き合わせられない（同じ日・同じ店のみ）。
 */
export function resolveVoucherChange(input: {
  settings: VoucherSettings & { legacy?: boolean };
  /** 特殊返金設定「商品券調整を精算に反映」 */
  reflectManualFromSpecialRefundSettings: boolean;
  autoByOrder: Record<string, number>;
  manualEvents: ManualVoucherEvent[];
}): VoucherChangeResolution {
  const s = input.settings;
  const empty: VoucherChangeResolution = {
    total: 0,
    autoTotal: 0,
    manualTotal: 0,
    appliedManual: [],
    skippedAutoOrderKeys: [],
    skippedManualOrderKeys: [],
    skippedAutoAmount: 0,
    skippedManualAmount: 0,
    legacy: Boolean(s.legacy),
  };
  const amountOf = (e: ManualVoucherEvent) => {
    const n = Number(e.voucherChangeAmount?.toString() ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  if (s.legacy) {
    // 今までの式: 自動の合計 ＋（特殊返金設定で反映がオンなら）手入力の合計
    const autoTotal = Object.values(input.autoByOrder).reduce((a, v) => a + (Number(v) || 0), 0);
    const manual = input.reflectManualFromSpecialRefundSettings ? input.manualEvents : [];
    const manualTotal = manual.reduce((a, e) => a + amountOf(e), 0);
    return {
      ...empty,
      total: Math.round(autoTotal + manualTotal),
      autoTotal: Math.round(autoTotal),
      manualTotal: Math.round(manualTotal),
      appliedManual: [...manual],
    };
  }
  if (!s.voucherFeatureEnabled || !s.reflectVoucherChangeInSettlement) return empty;

  const autoOn = Boolean(s.voucherAutoDetectionEnabled);
  const manualOn = Boolean(s.voucherManualAdjustmentEnabled) && input.reflectManualFromSpecialRefundSettings;

  const auto = new Map<string, number>();
  if (autoOn) {
    for (const [k, v] of Object.entries(input.autoByOrder)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) auto.set(normalizeOrderKey(k), (auto.get(normalizeOrderKey(k)) ?? 0) + n);
    }
  }
  const manualByOrder = new Map<string, ManualVoucherEvent[]>();
  if (manualOn) {
    for (const e of input.manualEvents) {
      const k = normalizeOrderKey(e.sourceOrderId);
      const list = manualByOrder.get(k) ?? [];
      list.push(e);
      manualByOrder.set(k, list);
    }
  }

  const manualFirst = s.voucherAdjustmentPriority !== "auto_first";
  const skippedAuto: string[] = [];
  const skippedManual: string[] = [];
  let autoTotal = 0;
  let manualTotal = 0;
  let skippedAutoAmount = 0;
  let skippedManualAmount = 0;
  const appliedManual: ManualVoucherEvent[] = [];

  for (const [k, v] of auto) {
    if (manualFirst && manualByOrder.has(k)) {
      skippedAuto.push(k);
      skippedAutoAmount += v;
      continue;
    }
    autoTotal += v;
  }
  for (const [k, list] of manualByOrder) {
    if (!manualFirst && auto.has(k)) {
      skippedManual.push(k);
      skippedManualAmount += list.reduce((a, e) => a + amountOf(e), 0);
      continue;
    }
    for (const e of list) {
      manualTotal += amountOf(e);
      appliedManual.push(e);
    }
  }

  return {
    total: Math.round(autoTotal + manualTotal),
    autoTotal: Math.round(autoTotal),
    manualTotal: Math.round(manualTotal),
    appliedManual,
    skippedAutoOrderKeys: skippedAuto,
    skippedManualOrderKeys: skippedManual,
    skippedAutoAmount: Math.round(skippedAutoAmount),
    skippedManualAmount: Math.round(skippedManualAmount),
    legacy: false,
  };
}

/** POS「商品券調整」を受け付けるか */
export function voucherManualAdjustmentAllowed(s: VoucherSettings & { legacy?: boolean }): boolean {
  if (s.legacy) return true; // 版の無い設定は今までどおり止めない
  return Boolean(s.voucherFeatureEnabled && s.voucherManualAdjustmentEnabled);
}
