/**
 * POS 純正の返金の付け替え（純関数）
 *
 * POS 純正で返金した注文で、実際は別の手段で返したとき（例: 施設ポイントで払った分を現金で返した）、
 * 純正の返金 1 件・支払方法 1 つごとに、返金額をそのまま「元の手段 → 実際の手段」へ移す。
 * - 金額は純正の返金額で決まる。分けるときも合計は返金額を超えない（T の決定 2026-11-23）
 * - Shopify では返金しない。登録は shopifyRefundStatus=success・shopifyRefundId=その返金にして、
 *   精算・ciara-system が「移すだけ」（返金の合計は変えない）で数えるようにする
 * - 数える日は純正で返金した日
 */

export const NATIVE_REFUND_SOURCE = "native";
export const NATIVE_REFUND_NOT_FOUND_CODE = "NATIVE_REFUND_NOT_FOUND";
export const NATIVE_REFUND_AMOUNT_EXCEEDED_CODE = "NATIVE_REFUND_AMOUNT_EXCEEDED";
export const NATIVE_REFUND_AMOUNT_FIXED_CODE = "NATIVE_REFUND_AMOUNT_FIXED";

export type ShopifyRefundTxForReassign = {
  kind?: string | null;
  status?: string | null;
  gateway?: string | null;
  formattedGateway?: string | null;
  amountSet?: { shopMoney?: { amount?: string | number | null } | null } | null;
  /** 返金を処理した POS の店（純正の POS の返金に付く） */
  location?: { id?: string | null } | null;
};

export type ShopifyRefundForReassign = {
  id: string;
  createdAt?: string | null;
  note?: string | null;
  transactions?: { nodes?: ShopifyRefundTxForReassign[] | null } | ShopifyRefundTxForReassign[] | null;
};

/** 純正の返金 1 件・支払方法 1 つ（付け替えの単位） */
export type NativeRefundLine = {
  refundId: string;
  createdAt: string | null;
  gateway: string;
  formattedGateway: string | null;
  amount: number;
  /** この返金を処理した POS の店（返金の取引に付いた店。無ければ null） */
  posLocationGid?: string | null;
  /**
   * この返金を精算で数える店（返金の計上の設定に従う）。読めたときだけ入る。
   * 返金方法変更の登録はこの店に付ける（純正の返金と同じ店の精算で内訳を移すため）
   */
  countLocationGid?: string | null;
};

/** 付け替えの登録のうち、残りを数えるのに使う列 */
export type ReassignEventRow = {
  status: string;
  approvalStatus?: string | null;
  shopifyRefundId?: string | null;
  originalPaymentMethod?: string | null;
  amount: number | string | { toString(): string };
};

function money(v: unknown): number {
  const n = Number(typeof v === "object" && v !== null ? String(v) : v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function key(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

export function sameGateway(a: unknown, b: unknown): boolean {
  const ka = key(a);
  return ka !== "" && ka === key(b);
}

/** このアプリが Shopify で実行した返金（純正の返金ではない）か。返金ノートの印で見分ける */
export function isAppExecutedRefundNote(note: string | null | undefined): boolean {
  const s = String(note ?? "");
  return s.includes("[POS_RECEIPT_EVENT:") || s.startsWith("POS Receipt 特殊返金");
}

function txList(refund: ShopifyRefundForReassign): ShopifyRefundTxForReassign[] {
  const t = refund.transactions;
  if (!t) return [];
  if (Array.isArray(t)) return t;
  return t.nodes ?? [];
}

/** 注文の返金から、純正の返金を 1 件・支払方法 1 つずつに並べる（アプリが実行した返金は外す） */
export function nativeRefundLines(refunds: ShopifyRefundForReassign[]): NativeRefundLine[] {
  const out: NativeRefundLine[] = [];
  for (const r of refunds ?? []) {
    if (!r?.id || isAppExecutedRefundNote(r.note)) continue;
    const byGateway = new Map<string, NativeRefundLine>();
    for (const tx of txList(r)) {
      const kind = String(tx.kind ?? "").toUpperCase();
      if (kind && kind !== "REFUND") continue;
      const status = String(tx.status ?? "").toUpperCase();
      if (status && status !== "SUCCESS") continue;
      const gateway = String(tx.gateway ?? "").trim();
      if (!gateway) continue;
      const k = key(gateway);
      const line = byGateway.get(k) ?? {
        refundId: r.id,
        createdAt: r.createdAt ?? null,
        gateway,
        formattedGateway: tx.formattedGateway ? String(tx.formattedGateway) : null,
        amount: 0,
        posLocationGid: null,
      };
      const txLoc = String(tx.location?.id ?? "").trim();
      if (txLoc && !line.posLocationGid) line.posLocationGid = txLoc;
      line.amount = money(line.amount + money(tx.amountSet?.shopMoney?.amount));
      byGateway.set(k, line);
    }
    for (const line of byGateway.values()) if (line.amount > 0) out.push(line);
  }
  return out.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
}

/** その返金・支払方法で、もう付け替えた額（有効で、却下されていない登録） */
export function reassignedAmountFor(line: Pick<NativeRefundLine, "refundId" | "gateway">, events: ReassignEventRow[]): number {
  let sum = 0;
  for (const e of events ?? []) {
    if (e.status !== "active") continue;
    if (String(e.approvalStatus ?? "") === "rejected") continue;
    if (String(e.shopifyRefundId ?? "") !== line.refundId) continue;
    if (!sameGateway(e.originalPaymentMethod, line.gateway)) continue;
    sum += money(e.amount);
  }
  return money(sum);
}

export function remainingFor(line: NativeRefundLine, events: ReassignEventRow[]): number {
  return Math.max(0, money(line.amount - reassignedAmountFor(line, events)));
}

export function findNativeRefundLine(
  lines: NativeRefundLine[],
  refundId: string,
  gateway: string | null | undefined,
): NativeRefundLine | null {
  return lines.find((l) => l.refundId === refundId && sameGateway(l.gateway, gateway)) ?? null;
}

export type NativeReassignCheck =
  | { ok: true; line: NativeRefundLine; remaining: number }
  | { ok: false; code: string; message: string };

/** 登録してよいか（返金があり、金額が残りを超えない） */
export function checkNativeReassign(
  lines: NativeRefundLine[],
  events: ReassignEventRow[],
  input: { refundId: string; originalPaymentMethod: string | null | undefined; amount: unknown },
): NativeReassignCheck {
  const line = findNativeRefundLine(lines, input.refundId, input.originalPaymentMethod);
  if (!line) {
    return {
      ok: false,
      code: NATIVE_REFUND_NOT_FOUND_CODE,
      message: "この注文に、その支払方法の純正の返金が見つかりません。画面を読み直してください。",
    };
  }
  const amount = money(input.amount);
  if (!(amount > 0)) {
    return { ok: false, code: "INVALID_AMOUNT", message: "金額は 0 より大きくしてください。" };
  }
  const remaining = remainingFor(line, events);
  if (amount > remaining + 0.005) {
    return {
      ok: false,
      code: NATIVE_REFUND_AMOUNT_EXCEEDED_CODE,
      message:
        remaining > 0
          ? `この返金で返金方法を変更できる残りは ¥${remaining.toLocaleString()} です。画面を読み直してください。`
          : "この返金はもう返金方法変更済みです。直すときは調整履歴の「変更」を使ってください。",
    };
  }
  return { ok: true, line, remaining };
}

export type NativeRefundCountContext = {
  /** 精算の「返金の計上ロケーション」 */
  mode: "order_transaction" | "refund_transaction_pos_location";
  /** 店の付かない返金（管理画面など）を数える店（店舗設定で 1 つだけ選べる） */
  nonPosRefundTargetLocationGid: string | null;
  nonPosRefundFallbackMode: "order_retail_location" | "exclude";
  /** 注文の販売店 */
  retailLocationGid: string | null;
  /** 注文のメタフィールド pos.refund_aggregation_location_gid（返金を数える店） */
  aggregationMetafieldGid: string | null;
};

function gidOf(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (s.startsWith("gid://")) return s;
  const m = s.match(/(\d+)$/);
  return m ? `gid://shopify/Location/${m[1]}` : null;
}

/**
 * 純正の返金 1 件を、精算でどの店の返金として数えるか（settlementAggregatePure の決め方に合わせる）。
 * - 「返品があった店で集計」: 返金の取引の店。店が付かない返金は注文のメタフィールドの店
 * - 「注文の店で集計」: 販売店（今までどおり）
 * - 店の付かない返金: 店舗設定で選んだ店 → 販売店（「数えない」設定のときは null）
 * 決められないときは null（呼ぶ側は今までどおり POS から来た店を使う）
 */
export function nativeRefundCountLocationGid(
  line: Pick<NativeRefundLine, "posLocationGid">,
  ctx: NativeRefundCountContext,
): string | null {
  const pos = gidOf(line.posLocationGid);
  const retail = gidOf(ctx.retailLocationGid);
  if (ctx.mode === "refund_transaction_pos_location") {
    if (pos) return pos;
    const mf = gidOf(ctx.aggregationMetafieldGid);
    if (mf) return mf;
  } else if (pos) {
    return retail ?? pos;
  }
  const target = gidOf(ctx.nonPosRefundTargetLocationGid);
  if (target) return target;
  if (ctx.nonPosRefundFallbackMode === "exclude") return null;
  return retail;
}
