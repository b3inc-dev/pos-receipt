/**
 * 精算・点検レシートの「表示のための計算」の設定（店ごと。管理画面で変える）
 *
 * 精算エンジンの金額（総売上・支払方法ごとの取引額など）は変えない。ここで決めるのは印字の並べ方と、
 * Ciara の gift-receipt.liquid が印字のときに計算していた 2 つだけ。
 * - 納金額 = 現金の取引額 − 指定した店の、指定した支払方法の返金 − 商品券釣り（事後調整は内訳に入っているので足さない）
 * - 支払方法の並び順と、まとめの行（例: 電子マネー(合計) を クレジットカード の後に、2 種類以上あるときだけ）
 *
 * 初期値は「何もしない」（並べ替えなし・まとめの行なし・特例の店なし）。Ciara の値は「Ciara の値を入れる」で入る。
 */

export const SETTLEMENT_CALC_SETTING_KEY = "receipt_layout_settlement_calc_v1";

export type PaymentGroupRule = {
  /** 印字する名前（例: 電子マネー(合計)） */
  label: string;
  /** まとめる支払方法の名前（大文字小文字は区別しない・完全一致） */
  members: string[];
  /** この支払方法の行のすぐ後に出す。空なら並びの最後 */
  insertAfter: string;
  /** まとめる支払方法のうち、動きがあるものがこの数以上のときだけ出す */
  minActive: number;
};

export type SettlementCalcSettings = {
  /** 納金額の「現金」とみなす支払方法の名前（含んでいれば現金。大文字小文字は区別しない） */
  cashLabels: string[];
  /** 返金を納金額から引く店（Shopify のロケーション ID か店の表示名） */
  refundDeductLocations: string[];
  /** 上の店で、返金を納金額から引く支払方法（名前に含んでいれば対象） */
  refundDeductMethods: string[];
  /** 支払方法を印字する順（完全一致・大文字小文字は区別しない）。無い支払方法は後ろに元の順で出す */
  paymentOrder: string[];
  groups: PaymentGroupRule[];
};

export const DEFAULT_SETTLEMENT_CALC: SettlementCalcSettings = {
  cashLabels: ["現金", "cash"],
  refundDeductLocations: [],
  refundDeductMethods: [],
  paymentOrder: [],
  groups: [],
};

/** Ciara の gift-receipt.liquid（2026-11-22）と同じ値。店の名前は Ciara の店で入れ直す */
export const CIARA_SETTLEMENT_CALC: SettlementCalcSettings = {
  cashLabels: ["現金", "cash"],
  refundDeductLocations: ["Ciara梅田エスト店", "Ciara天王寺ミオ店"],
  refundDeductMethods: ["wespo", "nanaco", "edy"],
  paymentOrder: [
    "現金",
    "クレジットカード",
    "電子マネー",
    "電子マネー(QR)",
    "電子マネー(nanaco/楽天Edy)",
    "交通系ICカード決済",
    "商品券釣無し",
    "商品券釣有り",
    "JRE POINT",
    "STACIAポイント",
    "WAONポイント",
    "wespoアプリポイント",
    "アプリポイント",
    "ポケパル",
    "銀聯",
  ],
  groups: [
    {
      label: "電子マネー(合計)",
      members: ["電子マネー", "電子マネー(QR)", "電子マネー(nanaco/楽天Edy)", "交通系ICカード決済"],
      insertAfter: "クレジットカード",
      minActive: 2,
    },
  ],
};

const MAX_LIST = 60;
const MAX_TEXT = 100;

function cleanList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\r?\n/) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const s = String(item ?? "").trim().slice(0, MAX_TEXT);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/** 保存値を読むときに使う（壊れた値は初期値へ） */
export function normalizeSettlementCalc(raw: unknown): SettlementCalcSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const groups = Array.isArray(o.groups) ? o.groups : [];
  return {
    cashLabels: o.cashLabels === undefined ? [...DEFAULT_SETTLEMENT_CALC.cashLabels] : cleanList(o.cashLabels),
    refundDeductLocations: cleanList(o.refundDeductLocations),
    refundDeductMethods: cleanList(o.refundDeductMethods),
    paymentOrder: cleanList(o.paymentOrder),
    groups: groups
      .slice(0, 10)
      .map((g) => {
        const r = g && typeof g === "object" ? (g as Record<string, unknown>) : {};
        const min = Math.round(Number(r.minActive));
        return {
          label: String(r.label ?? "").trim().slice(0, MAX_TEXT),
          members: cleanList(r.members),
          insertAfter: String(r.insertAfter ?? "").trim().slice(0, MAX_TEXT),
          minActive: Number.isFinite(min) ? Math.min(20, Math.max(1, min)) : 2,
        };
      })
      .filter((g) => g.label && g.members.length > 0),
  };
}

export type SettlementSectionInput = {
  label: string;
  net: number;
  refund: number;
  txCount: number;
  refundCount: number;
};

export type SettlementPaymentRow = {
  label: string;
  net: number;
  count: number;
  refund: number;
  refund_count: number;
  /** まとめの行（電子マネー(合計) など） */
  is_group: boolean;
};

const lc = (s: string) => s.trim().toLowerCase();
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function toRow(s: SettlementSectionInput): SettlementPaymentRow {
  return {
    label: s.label,
    net: num(s.net),
    count: num(s.txCount),
    refund: num(s.refund),
    refund_count: num(s.refundCount),
    is_group: false,
  };
}

function groupRow(rule: PaymentGroupRule, sections: SettlementSectionInput[]): SettlementPaymentRow | null {
  const members = new Set(rule.members.map(lc));
  const hits = sections.filter((s) => members.has(lc(s.label)));
  const active = hits.filter((s) => num(s.net) || num(s.refund) || num(s.txCount) || num(s.refundCount)).length;
  if (active < rule.minActive) return null;
  return {
    label: rule.label,
    net: hits.reduce((a, s) => a + num(s.net), 0),
    count: hits.reduce((a, s) => a + num(s.txCount), 0),
    refund: hits.reduce((a, s) => a + num(s.refund), 0),
    refund_count: hits.reduce((a, s) => a + num(s.refundCount), 0),
    is_group: true,
  };
}

/** 支払方法を設定の順に並べ、まとめの行を入れる */
export function orderSettlementPayments(
  sections: SettlementSectionInput[],
  calc: SettlementCalcSettings,
): SettlementPaymentRow[] {
  const used = new Set<number>();
  const ordered: SettlementPaymentRow[] = [];
  for (const want of calc.paymentOrder) {
    sections.forEach((s, i) => {
      if (!used.has(i) && lc(s.label) === lc(want)) {
        used.add(i);
        ordered.push(toRow(s));
      }
    });
  }
  sections.forEach((s, i) => {
    if (!used.has(i)) ordered.push(toRow(s));
  });

  // まとめの行。insertAfter の行が無いときは、その名前が並び順のどこにあるかで場所を決め、それも無ければ最後
  for (const rule of calc.groups) {
    const row = groupRow(rule, sections);
    if (!row) continue;
    const after = lc(rule.insertAfter);
    let at = after ? ordered.findIndex((r) => !r.is_group && lc(r.label) === after) : -1;
    if (at >= 0) {
      ordered.splice(at + 1, 0, row);
      continue;
    }
    const orderIdx = after ? calc.paymentOrder.findIndex((w) => lc(w) === after) : -1;
    if (orderIdx >= 0) {
      const laterNames = new Set(calc.paymentOrder.slice(orderIdx + 1).map(lc));
      at = ordered.findIndex((r) => !r.is_group && laterNames.has(lc(r.label)));
      ordered.splice(at >= 0 ? at : ordered.length, 0, row);
      continue;
    }
    ordered.push(row);
  }
  return ordered;
}

function locationMatches(calc: SettlementCalcSettings, locationId: string, locationName: string): boolean {
  const id = locationId.trim();
  const numericId = id.replace(/^gid:\/\/shopify\/Location\//, "");
  const name = lc(locationName);
  return calc.refundDeductLocations.some((v) => {
    const t = v.trim();
    return t === id || t === numericId || (name !== "" && lc(t) === name);
  });
}

/**
 * 納金額。Ciara の gift-receipt.liquid と同じ式:
 * 現金の取引額 − （特例の店なら）指定した支払方法の返金 − 商品券釣り
 */
export function settlementCashDeposit(
  sections: SettlementSectionInput[],
  opts: {
    calc: SettlementCalcSettings;
    locationId: string;
    locationName: string;
    voucherChange: number;
  },
): number {
  const cashKeys = opts.calc.cashLabels.map(lc).filter(Boolean);
  const deductKeys = opts.calc.refundDeductMethods.map(lc).filter(Boolean);
  const special = locationMatches(opts.calc, opts.locationId, opts.locationName);
  let cash = 0;
  let refundAdjust = 0;
  for (const s of sections) {
    const label = lc(s.label);
    if (cashKeys.some((k) => label.includes(k))) cash += num(s.net);
    if (special && deductKeys.some((k) => label.includes(k))) refundAdjust += num(s.refund);
  }
  // Ciara の liquid にあった「事後調整」（receipt_cash_manual_delta）は足さない。
  // このアプリでは「レシートの現金を直す」は精算エンジンが支払方法別の内訳（現金の取引額）にもう入れているので、足すと二重になる
  return cash - refundAdjust - num(opts.voucherChange);
}

// ── 販売レシートの値の設定 ──────────────────────────────

export const SALES_DATA_SETTING_KEY = "receipt_layout_sales_data_v1";

export type SalesDataSettings = {
  /** スタッフ名を探す明細のプロパティ名。見つからなければ明細の担当スタッフ（POS で選んだ人） */
  staffPropertyKeys: string[];
};

export const DEFAULT_SALES_DATA: SalesDataSettings = {
  staffPropertyKeys: ["スタッフ", "担当スタッフ", "販売スタッフ", "staff"],
};

export function normalizeSalesData(raw: unknown): SalesDataSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    staffPropertyKeys:
      o.staffPropertyKeys === undefined ? [...DEFAULT_SALES_DATA.staffPropertyKeys] : cleanList(o.staffPropertyKeys),
  };
}
