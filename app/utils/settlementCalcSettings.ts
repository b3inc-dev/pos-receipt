/**
 * 精算の数え方の設定（DB / Shopify 非依存）。
 *
 * 店ごとに運用が違う所を、コードに店の名前を書かずに管理画面で選べるようにする。
 * ciara-system の精算（GAS 精算レシートの移植）と同じ数え方にしたい店は、ここで選ぶ。
 * 初めの値は今の POS Receipt の数え方のまま（保存していない店の精算は変わらない）。
 *
 * 保存先は AppSetting の `settlement_calc_settings`。精算の画面（「精算の数え方」）で保存する。
 */

export const SETTLEMENT_CALC_SETTINGS_KEY = "settlement_calc_settings";

/** 返金の支払方法の付け替え（例: 特定の店で、wespo の返金を現金で払い出す運用） */
export type RefundRemapRule = {
  /** 支払方法の名前に含まれる文字（大文字と小文字は区別しない） */
  match: string;
  /** 付け替え先の支払方法の名前（精算の支払方法の名前。例: 現金） */
  toLabel: string;
  /** 対象の店の Shopify ロケーションの数字の ID。空文字はすべての店 */
  locationId: string;
};

export type SettlementCalcSettings = {
  /**
   * 売上を数える日。
   * - transaction: 決済（SALE / CAPTURE）の時刻の日（今の動き）
   * - order: 注文の日（processedAt）。決済が日をまたいでも注文の日に数え、
   *   売上の決済（SALE / CAPTURE）がまだ無い注文はオーソリ（AUTHORIZATION）を売上に数える
   */
  saleDateBasis: "transaction" | "order";
  /**
   * ギフトカードで払い出した返金を、現金の返金として精算から引く。
   * ギフトカードのメモに REFUND_CASH か REFUND_GC と「LOC:店の名前」があるものを数える。
   */
  giftCardRefundEnabled: boolean;
  /** ギフトカードの返金を載せる支払方法の名前 */
  giftCardRefundLabel: string;
  /** 点数に数えない商品の SKU（0 円の明細だけ外す。ノベルティなど） */
  itemCountExcludedSkus: string[];
  /** 返金の支払方法の付け替え（並べた順に見て、最初に当てはまったものを使う） */
  refundRemapRules: RefundRemapRule[];
  /**
   * 支払方法ごとの取引件数。
   * - sales: 売上の取引の件数（今の動き）
   * - sales_minus_refunds: 売上の取引の件数から返金の件数を引く（0 より下にしない）
   */
  paymentTxCountMode: "sales" | "sales_minus_refunds";
  /** 合計がマイナスになる日（返金が売上より多い日）は 0 にする（今の動き） */
  clampTotalAtZero: boolean;
  /**
   * 支払方法の分け方（精算の支払方法の行の名前の決め方）。
   * - builtin: 決まった分け方（gateway の名前から現金・クレジットカード・商品券などに分ける。今の動き）
   * - master: 支払方法マスタで分ける（当たったマスタの表示名を行の名前にする。当たらない取引は決まった分け方）
   */
  paymentKeySource: "builtin" | "master";
};

export const DEFAULT_SETTLEMENT_CALC_SETTINGS: SettlementCalcSettings = {
  saleDateBasis: "transaction",
  giftCardRefundEnabled: false,
  giftCardRefundLabel: "現金",
  itemCountExcludedSkus: [],
  refundRemapRules: [],
  paymentTxCountMode: "sales",
  clampTotalAtZero: true,
  paymentKeySource: "builtin",
};

export const ITEM_COUNT_EXCLUDED_SKUS_MAX = 200;
export const REFUND_REMAP_RULES_MAX = 20;
export const LABEL_MAX_LENGTH = 40;

/** SKU のそろえ方（前後の空白を取り、大文字にする） */
export function skuKey(raw: unknown): string {
  return typeof raw === "string" ? raw.normalize("NFKC").trim().toUpperCase() : "";
}

function str(v: unknown): string {
  return typeof v === "string" ? v.normalize("NFKC").trim() : "";
}

function locationNumericId(v: unknown): string {
  const s = str(v);
  if (!s) return "";
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/(\d+)$/);
  return m?.[1] ?? "";
}

function splitLines(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\r\n,、]+/) : [];
  return list.map(str).filter((v) => v !== "");
}

/**
 * 保存した値から、精算で使う設定を作る。壊れた値・知らない値は初めの値にする（精算を止めない）。
 */
export function resolveSettlementCalcSettings(saved: unknown): SettlementCalcSettings {
  const d = DEFAULT_SETTLEMENT_CALC_SETTINGS;
  if (!saved || typeof saved !== "object") return { ...d, itemCountExcludedSkus: [], refundRemapRules: [] };
  const s = saved as Record<string, unknown>;

  const skus: string[] = [];
  for (const v of splitLines(s.itemCountExcludedSkus)) {
    const k = skuKey(v);
    if (k && !skus.includes(k)) skus.push(k);
  }

  const rules: RefundRemapRule[] = [];
  if (Array.isArray(s.refundRemapRules)) {
    for (const r of s.refundRemapRules) {
      if (!r || typeof r !== "object") continue;
      const row = r as Record<string, unknown>;
      const match = str(row.match);
      const toLabel = str(row.toLabel);
      if (!match || !toLabel) continue;
      rules.push({ match, toLabel, locationId: locationNumericId(row.locationId) });
    }
  }

  return {
    saleDateBasis: s.saleDateBasis === "order" ? "order" : d.saleDateBasis,
    giftCardRefundEnabled: s.giftCardRefundEnabled === true,
    giftCardRefundLabel: str(s.giftCardRefundLabel) || d.giftCardRefundLabel,
    itemCountExcludedSkus: skus.slice(0, ITEM_COUNT_EXCLUDED_SKUS_MAX),
    refundRemapRules: rules.slice(0, REFUND_REMAP_RULES_MAX),
    paymentTxCountMode:
      s.paymentTxCountMode === "sales_minus_refunds" ? "sales_minus_refunds" : d.paymentTxCountMode,
    clampTotalAtZero: s.clampTotalAtZero === false ? false : d.clampTotalAtZero,
    paymentKeySource: s.paymentKeySource === "master" ? "master" : d.paymentKeySource,
  };
}

export type SettlementCalcSettingsInput = {
  saleDateBasis: unknown;
  giftCardRefundEnabled: unknown;
  giftCardRefundLabel: unknown;
  itemCountExcludedSkus: unknown;
  refundRemapRules: unknown;
  paymentTxCountMode: unknown;
  clampTotalAtZero: unknown;
  /** 古い画面から来たときは無い。無ければ初めの値 */
  paymentKeySource?: unknown;
};

/**
 * 画面から来た値を確かめる。1 つでも誤りがあれば保存しない（UI ルール 7章）。
 * @param legacyGiftCardAggregationEnabled 精算設定の「旧ギフトカード API 集計」が ON か
 */
export function validateSettlementCalcSettings(
  input: SettlementCalcSettingsInput,
  opts: { legacyGiftCardAggregationEnabled: boolean; knownLocationIds?: ReadonlySet<string> },
): { ok: true; settings: SettlementCalcSettings } | { ok: false; error: string } {
  if (input.saleDateBasis !== "transaction" && input.saleDateBasis !== "order") {
    return { ok: false, error: "「売上を数える日」を選んでください。" };
  }
  if (input.paymentTxCountMode !== "sales" && input.paymentTxCountMode !== "sales_minus_refunds") {
    return { ok: false, error: "「支払方法ごとの取引件数」を選んでください。" };
  }
  const paymentKeySource = input.paymentKeySource ?? DEFAULT_SETTLEMENT_CALC_SETTINGS.paymentKeySource;
  if (paymentKeySource !== "builtin" && paymentKeySource !== "master") {
    return { ok: false, error: "「支払方法の分け方」を選んでください。" };
  }
  const giftCardRefundEnabled = input.giftCardRefundEnabled === true;
  const giftCardRefundLabel = str(input.giftCardRefundLabel);
  if (giftCardRefundEnabled) {
    if (!giftCardRefundLabel) {
      return { ok: false, error: "「ギフトカードの返金を載せる支払方法」を入れてください。" };
    }
    if (opts.legacyGiftCardAggregationEnabled) {
      return {
        ok: false,
        error:
          "精算設定の「旧ギフトカード API 集計」が ON です。返金のギフトカードが売上にも数えられて二重になるため、先にそちらを OFF にしてください。",
      };
    }
  }
  if (giftCardRefundLabel.length > LABEL_MAX_LENGTH) {
    return { ok: false, error: `「ギフトカードの返金を載せる支払方法」は ${LABEL_MAX_LENGTH} 文字までです。` };
  }

  const skuList = splitLines(input.itemCountExcludedSkus).map(skuKey);
  const skus: string[] = [];
  for (const k of skuList) if (k && !skus.includes(k)) skus.push(k);
  if (skus.length > ITEM_COUNT_EXCLUDED_SKUS_MAX) {
    return { ok: false, error: `「点数に数えない商品の SKU」は ${ITEM_COUNT_EXCLUDED_SKUS_MAX} 個までです。` };
  }

  const rawRules = Array.isArray(input.refundRemapRules) ? input.refundRemapRules : [];
  if (rawRules.length > REFUND_REMAP_RULES_MAX) {
    return { ok: false, error: `「返金の支払方法の付け替え」は ${REFUND_REMAP_RULES_MAX} 行までです。` };
  }
  const rules: RefundRemapRule[] = [];
  for (let i = 0; i < rawRules.length; i++) {
    const row = (rawRules[i] ?? {}) as Record<string, unknown>;
    const match = str(row.match);
    const toLabel = str(row.toLabel);
    const locationId = locationNumericId(row.locationId);
    const rowNo = i + 1;
    if (!match && !toLabel) continue; // 空の行は捨てる
    if (!match) return { ok: false, error: `「返金の支払方法の付け替え」の ${rowNo} 行目の「支払方法に含まれる文字」を入れてください。` };
    if (!toLabel) return { ok: false, error: `「返金の支払方法の付け替え」の ${rowNo} 行目の「付け替え先」を入れてください。` };
    if (match.length > LABEL_MAX_LENGTH || toLabel.length > LABEL_MAX_LENGTH) {
      return { ok: false, error: `「返金の支払方法の付け替え」の ${rowNo} 行目は ${LABEL_MAX_LENGTH} 文字までです。` };
    }
    if (str(row.locationId) && !locationId) {
      return { ok: false, error: `「返金の支払方法の付け替え」の ${rowNo} 行目の店が読み取れません。` };
    }
    if (locationId && opts.knownLocationIds && !opts.knownLocationIds.has(locationId)) {
      return { ok: false, error: `「返金の支払方法の付け替え」の ${rowNo} 行目の店が見つかりません。ロケーションを読み直してください。` };
    }
    rules.push({ match, toLabel, locationId });
  }

  return {
    ok: true,
    settings: {
      saleDateBasis: input.saleDateBasis,
      giftCardRefundEnabled,
      giftCardRefundLabel: giftCardRefundLabel || DEFAULT_SETTLEMENT_CALC_SETTINGS.giftCardRefundLabel,
      itemCountExcludedSkus: skus,
      refundRemapRules: rules,
      paymentTxCountMode: input.paymentTxCountMode,
      clampTotalAtZero: input.clampTotalAtZero !== false,
      paymentKeySource,
    },
  };
}

/**
 * 返金の支払方法の名前を、付け替えの決まりで変える。当てはまらなければそのまま。
 * @param label 精算の支払方法の名前（「支払方法の分け方」で決めた集計キー。初めは gasNormalizeGatewayLabel の結果）
 * @param raw 元の gateway・formattedGateway（名前に出ない文字でも当てられるように）
 */
export function remapRefundLabel(
  label: string,
  raw: { gateway?: string | null; formattedGateway?: string | null },
  rules: readonly RefundRemapRule[],
  locIdRaw: string,
): string {
  if (!rules.length) return label;
  const hay = `${label} ${raw.gateway ?? ""} ${raw.formattedGateway ?? ""}`.toLowerCase();
  for (const r of rules) {
    if (r.locationId && r.locationId !== locIdRaw) continue;
    if (hay.includes(r.match.toLowerCase())) return r.toLabel;
  }
  return label;
}

/** 支払方法ごとの取引件数（画面・印字に出す件数） */
export function paymentSectionTxCount(
  saleTx: number,
  refundTx: number,
  mode: SettlementCalcSettings["paymentTxCountMode"],
): number {
  if (mode === "sales_minus_refunds") return Math.max(0, saleTx - refundTx);
  return saleTx;
}
