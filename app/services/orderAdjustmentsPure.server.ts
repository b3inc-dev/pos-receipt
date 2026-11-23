/**
 * 特殊返金（③）と商品券調整（④）を注文に残すメタフィールド `pos.adjustments` の形と数え方（純関数）。
 * 仕様の正本は docs/ORDER_ADJUSTMENTS_METAFIELD.md。ciara-system も同じ決まりで読む。
 *
 * - 注文 1 件に JSON 1 つ。行（entry）は消さない。直すときは前の行を "voided" にして、replaces 付きの行を足す。
 * - 値はアプリの DB（SpecialRefundEvent）から毎回まるごと作り直して書く（DB = 履歴と「日・店→注文」の目次）。
 * - 精算は、DB の目次でその日・その店の注文を出し、数はメタフィールドの行から読む。
 *   メタフィールドが読めない・行が DB と違うときは警告を出す（読めないときだけ DB の行で数える）。
 */
import { builtinPaymentKeyResolver } from "./settlementAggregatePure.server";

export const ORDER_ADJUSTMENTS_NAMESPACE = "pos";
export const ORDER_ADJUSTMENTS_KEY = "adjustments";
export const ORDER_ADJUSTMENTS_SUMMARY_KEY = "adjustments_summary";
export const ORDER_ADJUSTMENTS_VERSION = 1;
/** 人が読むための 1 行の上限（single_line_text_field に入れる） */
export const ORDER_ADJUSTMENTS_SUMMARY_MAX = 250;

export type AdjustmentEntryType = "special_refund" | "voucher";
export type AdjustmentEntryStatus = "active" | "voided" | "pending_approval" | "rejected";

export interface OrderAdjustmentEntry {
  id: string;
  type: AdjustmentEntryType;
  /** cash_refund | payment_method_override | receipt_cash_adjustment | voucher_change_adjustment */
  kind: string;
  /** receipt_cash_adjustment のときだけ: undo | extra */
  adjustKind: string | null;
  /** 数える日（店のタイムゾーン、YYYY-MM-DD）。注文の日と違ってよい */
  date: string;
  /** gid://shopify/Location/<数字> */
  locationGid: string;
  /** 元の支払方法（支払方法マスタの gateway の名前） */
  fromMethod: string | null;
  /** 実際に返した手段（支払方法マスタの gateway の名前） */
  toMethod: string | null;
  /** 支払方法マスタの表示名（読みやすさのため。数えるときは使わない） */
  fromLabel: string | null;
  toLabel: string | null;
  /** 金額（店の通貨の円などの単位）。商品券はお釣り */
  amount: number;
  currency: string;
  voucher: { face: number; applied: number; change: number } | null;
  shopifyRefund: { status: string; id: string | null };
  status: AdjustmentEntryStatus;
  replaces: string | null;
  replacedBy: string | null;
  // 登録した人（by）と直したわけ（reason）は注文に入れない（ほかのアプリからも読める名前空間のため。DB だけに残す）
  /** 登録した時刻（ISO・UTC） */
  at: string;
  voidedAt: string | null;
}

export interface OrderAdjustmentsDoc {
  version: number;
  updatedAt: string;
  entries: OrderAdjustmentEntry[];
}

/** DB の SpecialRefundEvent のうち、メタフィールドを作るのに使う列 */
export interface AdjustmentEventRow {
  id: string;
  sourceOrderId: string;
  sourceOrderName?: string | null;
  locationId: string;
  eventType: string;
  amount: number | { toString(): string };
  currency?: string | null;
  originalPaymentMethod: string | null;
  actualRefundMethod: string | null;
  voucherFaceValue?: number | { toString(): string } | null;
  voucherAppliedAmount?: number | { toString(): string } | null;
  voucherChangeAmount?: number | { toString(): string } | null;
  adjustKind: string | null;
  createdBy?: string | null;
  status: string;
  shopifyRefundStatus?: string | null;
  shopifyRefundId?: string | null;
  approvalStatus?: string | null;
  countDate?: string | null;
  /** native = POS 純正の返金の付け替え（金額は純正の返金で決まる） */
  refundSource?: string | null;
  replacesEventId?: string | null;
  voidedAt?: Date | null;
  voidReason?: string | null;
  /** 注文に書けた時刻・書けなかった理由（どちらも無い注文は、注文に書く設定にする前の登録で、まだ書いていない） */
  metafieldSyncedAt?: Date | null;
  metafieldSyncError?: string | null;
  note?: string | null;
  createdAt: Date;
}

const LOCATION_PREFIX = "gid://shopify/Location/";

function num(v: number | { toString(): string } | null | undefined): number {
  if (v == null) return 0;
  const n = Number(typeof v === "number" ? v : v.toString());
  return Number.isFinite(n) ? n : 0;
}

/** 円などの金額を小数 2 桁までにそろえる（Decimal(18,2) と同じ） */
function money(v: number | { toString(): string } | null | undefined): number {
  return Math.round(num(v) * 100) / 100;
}

export function toLocationGid(locationId: string | null | undefined): string {
  const s = String(locationId ?? "").trim();
  if (!s) return "";
  if (s.startsWith(LOCATION_PREFIX)) return s;
  const digits = s.replace(/\D/g, "");
  return digits ? `${LOCATION_PREFIX}${digits}` : s;
}

export function toOrderGid(orderId: string): string {
  const s = String(orderId ?? "").trim();
  if (s.startsWith("gid://")) return s;
  return `gid://shopify/Order/${s.replace(/\D/g, "")}`;
}

/** YYYY-MM-DD（店のタイムゾーン） */
export function calendarDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** その行を数える日。前からの登録（countDate なし）は登録した日 */
export function countDateOf(row: Pick<AdjustmentEventRow, "countDate" | "createdAt">, timeZone: string): string {
  return isIsoDate(row.countDate) ? row.countDate : calendarDateInTimeZone(row.createdAt, timeZone);
}

export function entryTypeOf(eventType: string): AdjustmentEntryType {
  return eventType === "voucher_change_adjustment" ? "voucher" : "special_refund";
}

/** DB の status と approvalStatus から、メタフィールドの status を決める */
export function entryStatusOf(row: Pick<AdjustmentEventRow, "status" | "approvalStatus">): AdjustmentEntryStatus {
  if (row.status === "voided") return "voided";
  const a = String(row.approvalStatus ?? "none");
  if (a === "pending") return "pending_approval";
  if (a === "rejected") return "rejected";
  return "active";
}

export type MethodLabelOf = (method: string) => string | null;

/** DB の行 → メタフィールドの行 */
export function eventRowToEntry(
  row: AdjustmentEventRow,
  ctx: { timeZone: string; labelOf?: MethodLabelOf; replacedBy?: string | null },
): OrderAdjustmentEntry {
  const type = entryTypeOf(row.eventType);
  const voucher =
    type === "voucher"
      ? {
          face: money(row.voucherFaceValue),
          applied: money(row.voucherAppliedAmount),
          change: money(row.voucherChangeAmount ?? row.amount),
        }
      : null;
  const label = (m: string | null) => (m && ctx.labelOf ? ctx.labelOf(m) : null);
  return {
    id: row.id,
    type,
    kind: row.eventType,
    adjustKind: row.eventType === "receipt_cash_adjustment" ? (row.adjustKind ?? "undo") : null,
    date: countDateOf(row, ctx.timeZone),
    locationGid: toLocationGid(row.locationId),
    fromMethod: type === "voucher" ? null : (row.originalPaymentMethod ?? null),
    toMethod: type === "voucher" ? null : (row.actualRefundMethod ?? null),
    fromLabel: type === "voucher" ? null : label(row.originalPaymentMethod),
    toLabel: type === "voucher" ? null : label(row.actualRefundMethod),
    amount: type === "voucher" ? voucher!.change : money(row.amount),
    currency: row.currency ?? "JPY",
    voucher,
    shopifyRefund: {
      status: String(row.shopifyRefundStatus ?? "none"),
      id: row.shopifyRefundId ?? null,
    },
    status: entryStatusOf(row),
    replaces: row.replacesEventId ?? null,
    replacedBy: ctx.replacedBy ?? null,
    at: row.createdAt.toISOString(),
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
  };
}

/** その注文の DB の行（全部）→ メタフィールドの値。行は登録した順 */
export function buildOrderAdjustmentsDoc(
  rows: AdjustmentEventRow[],
  ctx: { timeZone: string; labelOf?: MethodLabelOf; now?: Date },
): OrderAdjustmentsDoc {
  const sorted = [...rows].sort((a, b) => {
    const d = a.createdAt.getTime() - b.createdAt.getTime();
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  const replacedBy = new Map<string, string>();
  for (const r of sorted) {
    if (r.replacesEventId) replacedBy.set(r.replacesEventId, r.id);
  }
  return {
    version: ORDER_ADJUSTMENTS_VERSION,
    updatedAt: (ctx.now ?? new Date()).toISOString(),
    entries: sorted.map((r) =>
      eventRowToEntry(r, { timeZone: ctx.timeZone, labelOf: ctx.labelOf, replacedBy: replacedBy.get(r.id) ?? null }),
    ),
  };
}

const KIND_LABEL: Record<string, string> = {
  cash_refund: "現金返金",
  payment_method_override: "返金手段の付け替え",
  receipt_cash_adjustment: "レシート現金調整",
  voucher_change_adjustment: "商品券",
};

function yen(n: number): string {
  return `¥${Math.round(n).toLocaleString("ja-JP")}`;
}

/** 人が読むための 1 行（有効・承認待ちの行だけ）。例: 「11/23 返金手段の付け替え クレジット→現金 ¥1,200 ／ 11/23 商品券 額面¥5,000 お釣り¥800」 */
export function buildOrderAdjustmentsSummary(doc: OrderAdjustmentsDoc): string {
  const parts: string[] = [];
  for (const e of doc.entries) {
    if (e.status === "voided" || e.status === "rejected") continue;
    const md = e.date.slice(5).replace(/^0/, "").replace("-0", "/").replace("-", "/");
    const head = `${md} ${KIND_LABEL[e.kind] ?? e.kind}`;
    const pending = e.status === "pending_approval" ? "（承認待ち）" : "";
    if (e.type === "voucher" && e.voucher) {
      parts.push(`${head} 額面${yen(e.voucher.face)} お釣り${yen(e.voucher.change)}${pending}`);
    } else if (e.kind === "receipt_cash_adjustment") {
      const k = e.adjustKind === "extra" ? "追加" : "取り消し";
      parts.push(`${head}（${k}） ${e.fromLabel ?? e.fromMethod ?? "現金"} ${yen(e.amount)}${pending}`);
    } else {
      const from = e.fromLabel ?? e.fromMethod;
      const to = e.toLabel ?? e.toMethod ?? "現金";
      parts.push(`${head} ${from ? `${from}→` : ""}${to} ${yen(e.amount)}${pending}`);
    }
  }
  const s = parts.join(" ／ ");
  if (s.length <= ORDER_ADJUSTMENTS_SUMMARY_MAX) return s;
  return `${s.slice(0, ORDER_ADJUSTMENTS_SUMMARY_MAX - 1)}…`;
}

export type ParsedAdjustmentsDoc =
  | { ok: true; doc: OrderAdjustmentsDoc }
  | { ok: false; reason: "missing" | "invalid_json" | "invalid_shape" };

function asEntry(raw: unknown): OrderAdjustmentEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.kind !== "string") return null;
  if (!isIsoDate(r.date)) return null;
  const amount = Number(r.amount);
  if (!Number.isFinite(amount)) return null;
  const status = String(r.status ?? "");
  if (!["active", "voided", "pending_approval", "rejected"].includes(status)) return null;
  const sr = (r.shopifyRefund ?? {}) as Record<string, unknown>;
  const v = r.voucher as Record<string, unknown> | null | undefined;
  const str = (x: unknown) => (typeof x === "string" && x !== "" ? x : null);
  return {
    id: r.id,
    type: r.type === "voucher" || r.kind === "voucher_change_adjustment" ? "voucher" : "special_refund",
    kind: r.kind,
    adjustKind: str(r.adjustKind),
    date: r.date,
    locationGid: toLocationGid(String(r.locationGid ?? "")),
    fromMethod: str(r.fromMethod),
    toMethod: str(r.toMethod),
    fromLabel: str(r.fromLabel),
    toLabel: str(r.toLabel),
    amount,
    currency: str(r.currency) ?? "JPY",
    voucher:
      v && typeof v === "object"
        ? { face: Number(v.face) || 0, applied: Number(v.applied) || 0, change: Number(v.change) || 0 }
        : null,
    shopifyRefund: { status: String(sr.status ?? "none"), id: str(sr.id) },
    status: status as AdjustmentEntryStatus,
    replaces: str(r.replaces),
    replacedBy: str(r.replacedBy),
    at: String(r.at ?? ""),
    voidedAt: str(r.voidedAt),
  };
}

/** メタフィールドの値を読む。形がおかしい行は捨てずに、全体を invalid_shape にする（黙って数えないため） */
export function parseOrderAdjustmentsDoc(value: string | null | undefined): ParsedAdjustmentsDoc {
  if (value == null || String(value).trim() === "") return { ok: false, reason: "missing" };
  let raw: unknown;
  try {
    raw = JSON.parse(String(value));
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  const list = Array.isArray(raw) ? raw : (raw as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) return { ok: false, reason: "invalid_shape" };
  const entries: OrderAdjustmentEntry[] = [];
  for (const item of list) {
    const e = asEntry(item);
    if (!e) return { ok: false, reason: "invalid_shape" };
    entries.push(e);
  }
  const version = Number((raw as { version?: unknown })?.version ?? ORDER_ADJUSTMENTS_VERSION);
  return {
    ok: true,
    doc: {
      version: Number.isFinite(version) ? version : ORDER_ADJUSTMENTS_VERSION,
      updatedAt: String((raw as { updatedAt?: unknown })?.updatedAt ?? ""),
      entries,
    },
  };
}

/** その日・その店の行（無効は除く。承認待ち・却下は残して、精算の承認の扱いに任せる） */
export function entriesForDayAndLocation(
  doc: OrderAdjustmentsDoc,
  date: string,
  locationGid: string,
): OrderAdjustmentEntry[] {
  const loc = toLocationGid(locationGid);
  return doc.entries.filter((e) => e.status !== "voided" && e.date === date && e.locationGid === loc);
}

/** 精算エンジンが今まで DB の行から読んでいた形（数え方は変えない） */
export interface SettlementAdjustmentEvent {
  id: string;
  sourceOrderId: string;
  sourceOrderName: string | null;
  eventType: string;
  amount: number;
  originalPaymentMethod: string | null;
  actualRefundMethod: string | null;
  adjustKind: string | null;
  shopifyRefundStatus: string;
  status: "active";
  approvalStatus: string;
  voucherChangeAmount: number | null;
}

export function entryToSettlementEvent(
  e: OrderAdjustmentEntry,
  order: { sourceOrderId: string; sourceOrderName: string | null },
): SettlementAdjustmentEvent {
  return {
    id: e.id,
    sourceOrderId: order.sourceOrderId,
    sourceOrderName: order.sourceOrderName,
    eventType: e.kind,
    amount: e.type === "voucher" ? (e.voucher?.change ?? e.amount) : e.amount,
    originalPaymentMethod: e.fromMethod,
    actualRefundMethod: e.toMethod,
    adjustKind: e.adjustKind,
    shopifyRefundStatus: e.shopifyRefund.status,
    status: "active",
    approvalStatus:
      e.status === "pending_approval" ? "pending" : e.status === "rejected" ? "rejected" : "none",
    voucherChangeAmount: e.type === "voucher" ? (e.voucher?.change ?? e.amount) : null,
  };
}

/** 比べるときの指紋（数に効く項目だけ） */
function fingerprint(e: SettlementAdjustmentEvent): string {
  return [
    e.id,
    e.eventType,
    money(e.amount).toFixed(2),
    e.originalPaymentMethod ?? "",
    e.actualRefundMethod ?? "",
    e.adjustKind ?? "",
    e.shopifyRefundStatus,
    e.approvalStatus === "pending" || e.approvalStatus === "rejected" ? e.approvalStatus : "none",
    e.voucherChangeAmount == null ? "" : money(e.voucherChangeAmount).toFixed(2),
  ].join("|");
}

export function dbRowToSettlementEvent(r: AdjustmentEventRow): SettlementAdjustmentEvent {
  const isVoucher = r.eventType === "voucher_change_adjustment";
  return {
    id: r.id,
    sourceOrderId: r.sourceOrderId,
    sourceOrderName: r.sourceOrderName ?? null,
    eventType: r.eventType,
    amount: isVoucher ? money(r.voucherChangeAmount ?? r.amount) : money(r.amount),
    originalPaymentMethod: isVoucher ? null : r.originalPaymentMethod,
    actualRefundMethod: isVoucher ? null : r.actualRefundMethod,
    adjustKind: r.eventType === "receipt_cash_adjustment" ? (r.adjustKind ?? "undo") : null,
    shopifyRefundStatus: String(r.shopifyRefundStatus ?? "none"),
    status: "active",
    approvalStatus: String(r.approvalStatus ?? "none"),
    voucherChangeAmount: isVoucher ? money(r.voucherChangeAmount ?? r.amount) : null,
  };
}

export type AdjustmentSourceWarningReason =
  | "metafield_missing"
  | "metafield_invalid"
  | "metafield_differs"
  /** 少し前に書き直したのに、まだ違う（ほかのアプリが書き換えている）。続けて書き直さない */
  | "metafield_differs_again";

export interface AdjustmentSourceWarning {
  reason: AdjustmentSourceWarningReason;
  sourceOrderId: string;
  sourceOrderName: string | null;
}

export function adjustmentSourceWarningMessage(w: AdjustmentSourceWarning): string {
  const order = w.sourceOrderName || w.sourceOrderId.replace(/^gid:\/\/shopify\/Order\//, "");
  const tail = "精算はアプリの記録で数えています。注文を読むほかのアプリ（ciara-system など）とずれることがあるので、管理画面の注文ごとの記録で「書き直す」を押してください。";
  switch (w.reason) {
    case "metafield_missing":
      return `注文 ${order}: 特殊返金・商品券の記録を注文に書けていません。${tail}`;
    case "metafield_invalid":
      return `注文 ${order}: 注文の「特殊返金・商品券調整」の形が読めず、書き直しもできませんでした。${tail}`;
    case "metafield_differs":
      return `注文 ${order}: 注文の「特殊返金・商品券調整」がアプリの記録と違い、書き直しもできませんでした。${tail}`;
    case "metafield_differs_again":
      return `注文 ${order}: 注文の「特殊返金・商品券調整」を少し前に書き直しましたが、まだアプリの記録と違います。ほかのアプリや Shopify の画面で書き換えられている可能性があります。精算はアプリの記録で数えています。続けて書き直すことはしないので、書き換えている所を確かめてから、管理画面の注文ごとの記録で「書き直す」を押してください。`;
  }
}

/** 注文の値を書き直す必要がある注文（アプリの記録と違う・無い・読めない） */
export interface AdjustmentResyncNeed extends AdjustmentSourceWarning {}

/** 精算で書き直してからこの時間のうちにまた違っていたら、書き直さずに知らせる（同じ注文を何度も書き換えない） */
export const ADJUSTMENT_REWRITE_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * その注文を、注文に書く設定にしてから書いたことがあるか（書けた・書けなかったのどちらかが残っている）。
 * どちらも無い注文は設定より前の登録で、精算では比べも書き直しもしない（前からの登録は管理画面から T が書く）。
 */
export function isOrderWrittenSinceSwitch(rows: Pick<AdjustmentEventRow, "metafieldSyncedAt" | "metafieldSyncError">[]): boolean {
  return rows.some((r) => r.metafieldSyncedAt != null || (r.metafieldSyncError != null && r.metafieldSyncError !== ""));
}

/**
 * 注文の値（raw）が、その日・その店のアプリの記録（rows）と同じか。
 * 違う・無い・読めないときは理由を返す。同じなら null。
 */
export function orderDocMismatch(input: {
  date: string;
  locationGid: string;
  rows: AdjustmentEventRow[];
  raw: string | null;
}): "metafield_missing" | "metafield_invalid" | "metafield_differs" | null {
  const parsed = parseOrderAdjustmentsDoc(input.raw);
  if (!parsed.ok) return parsed.reason === "missing" ? "metafield_missing" : "metafield_invalid";
  const sourceOrderId = input.rows[0]?.sourceOrderId ?? "";
  const sourceOrderName = input.rows.find((r) => r.sourceOrderName)?.sourceOrderName ?? null;
  const fromDb = input.rows.map(dbRowToSettlementEvent);
  const fromDoc = entriesForDayAndLocation(parsed.doc, input.date, input.locationGid).map((e) =>
    entryToSettlementEvent(e, { sourceOrderId, sourceOrderName }),
  );
  const a = fromDb.map(fingerprint).sort().join("\n");
  const b = fromDoc.map(fingerprint).sort().join("\n");
  return a === b ? null : "metafield_differs";
}

/** 行を注文ごとにまとめる（キーは注文の GID） */
export function groupAdjustmentRowsByOrder(rows: AdjustmentEventRow[]): Map<string, AdjustmentEventRow[]> {
  const byOrder = new Map<string, AdjustmentEventRow[]>();
  for (const r of rows) {
    const key = toOrderGid(r.sourceOrderId);
    const list = byOrder.get(key) ?? [];
    list.push(r);
    byOrder.set(key, list);
  }
  return byOrder;
}

/**
 * その日・その店で数える特殊返金・商品券調整を決める（T の決定 2026-11-23: 違うときはアプリの記録）。
 * - 数えるのはいつもアプリの記録（DB）。書くのは pos-receipt だけなので、違うときは DB が新しいか、注文の値が外で書き換えられたか
 * - 比べるのは、注文に書く設定にしてから書いた注文だけ（isOrderWrittenSinceSwitch）。前からの登録はここでは書かない
 * - 注文の値が DB と違う・無い・読めない注文は needsResync に入れる（呼び出し側が注文を書き直し、書けなければ警告にする）
 * - 精算で少し前に書き直した注文（recentlyRewritten）がまた違うときは、書き直さずに warnings に入れる
 * - docsFetched=false（読まなかった・読めなかった・注文に書かない設定）のときは比べない
 */
export function resolveSettlementAdjustments(input: {
  date: string;
  locationGid: string;
  dbRows: AdjustmentEventRow[];
  docs: Map<string, string | null>;
  docsFetched: boolean;
  /** 精算で少し前に書き直した注文の GID */
  recentlyRewritten?: ReadonlySet<string>;
}): {
  events: SettlementAdjustmentEvent[];
  needsResync: AdjustmentResyncNeed[];
  warnings: AdjustmentSourceWarning[];
  notWrittenOrderCount: number;
} {
  const events: SettlementAdjustmentEvent[] = [];
  const needsResync: AdjustmentResyncNeed[] = [];
  const warnings: AdjustmentSourceWarning[] = [];
  let notWrittenOrderCount = 0;
  for (const [orderGid, rows] of groupAdjustmentRowsByOrder(input.dbRows)) {
    events.push(...rows.map(dbRowToSettlementEvent));
    if (!input.docsFetched) continue;
    if (!isOrderWrittenSinceSwitch(rows)) {
      notWrittenOrderCount += 1;
      continue;
    }
    const reason = orderDocMismatch({
      date: input.date,
      locationGid: input.locationGid,
      rows,
      raw: input.docs.get(orderGid) ?? null,
    });
    if (!reason) continue;
    const sourceOrderName = rows.find((r) => r.sourceOrderName)?.sourceOrderName ?? null;
    const sourceOrderId = rows[0].sourceOrderId;
    if (reason === "metafield_differs" && input.recentlyRewritten?.has(orderGid)) {
      warnings.push({ reason: "metafield_differs_again", sourceOrderId, sourceOrderName });
      continue;
    }
    needsResync.push({ reason, sourceOrderId, sourceOrderName });
  }
  return { events, needsResync, warnings, notWrittenOrderCount };
}

/** 注文の値（pos.adjustments）が、アプリの記録から作った値と同じか */
export type OrderMetafieldState = "same" | "differs" | "missing" | "invalid" | "unreadable" | "none";

/** 表示名（fromLabel / toLabel）はマスタの名前を変えると変わるので比べない */
function comparableEntries(doc: OrderAdjustmentsDoc): string {
  return JSON.stringify(doc.entries.map(({ fromLabel: _f, toLabel: _t, ...rest }) => rest));
}

export function orderMetafieldStateOf(input: {
  /** アプリの記録（DB）の行の数 */
  rowCount: number;
  /** メタフィールドを読めたか */
  fetched: boolean;
  currentValue: string | null | undefined;
  built: OrderAdjustmentsDoc;
}): OrderMetafieldState {
  if (!input.fetched) return "unreadable";
  const parsed = parseOrderAdjustmentsDoc(input.currentValue);
  if (!parsed.ok) {
    if (input.rowCount === 0) return "none";
    return parsed.reason === "missing" ? "missing" : "invalid";
  }
  if (input.rowCount === 0 && parsed.doc.entries.length === 0) return "none";
  return comparableEntries(parsed.doc) === comparableEntries(input.built) ? "same" : "differs";
}

/**
 * 注文の取引から、商品券で払った額（使った額）を出す。
 * 決まった分け方で「商品券」の種類になる支払方法の、成功した売上（SALE・CAPTURE）を足し、返金を引く。
 */
export function voucherAppliedFromTransactions(
  txs: { kind?: string | null; status?: string | null; gateway?: string | null; formattedGateway?: string | null; amount: number | string }[],
  /** 支払方法マスタで商品券にした支払方法か（決まった分け方の「商品券」に加えて見る） */
  isVoucherByMaster: (gateway: string, formattedGateway?: string | null) => boolean = () => false,
): { applied: number; found: boolean } {
  let applied = 0;
  let found = false;
  for (const tx of txs) {
    const status = String(tx.status ?? "SUCCESS").toUpperCase();
    if (status !== "SUCCESS") continue;
    const gateway = tx.gateway ?? "";
    const isVoucher =
      builtinPaymentKeyResolver(gateway, tx.formattedGateway).kind === "voucher" ||
      isVoucherByMaster(gateway, tx.formattedGateway);
    if (!isVoucher) continue;
    const amt = Math.abs(Number(tx.amount) || 0);
    const kind = String(tx.kind ?? "").toUpperCase();
    if (kind === "SALE" || kind === "CAPTURE") {
      applied += amt;
      found = true;
    } else if (kind === "REFUND") applied -= amt;
  }
  return { applied: Math.max(0, Math.round(applied * 100) / 100), found };
}

/** 額面と使った額からお釣り */
export function voucherChangeOf(face: number, applied: number): number {
  return Math.max(0, Math.round((Number(face) - Number(applied)) * 100) / 100);
}

/** 「変更」で受け取る中身 */
export interface AdjustmentEditInput {
  amount?: number | null;
  originalPaymentMethod?: string | null;
  actualRefundMethod?: string | null;
  adjustKind?: string | null;
  voucherFaceValue?: number | null;
  voucherAppliedAmount?: number | null;
  note?: string | null;
  /** original（元の日のまま・初めの値）| today（今日にする） */
  dateMode?: "original" | "today";
  reason?: string | null;
  by?: string | null;
}

export type AdjustmentEditPlan =
  | {
      ok: true;
      /** 新しい行に入れる値（id・shopId などは呼び出し側） */
      create: {
        sourceOrderId: string;
        sourceOrderName: string | null;
        locationId: string;
        eventType: string;
        amount: number;
        currency: string;
        originalPaymentMethod: string | null;
        actualRefundMethod: string | null;
        voucherFaceValue: number | null;
        voucherAppliedAmount: number | null;
        voucherChangeAmount: number | null;
        adjustKind: string | null;
        note: string | null;
        createdBy: string | null;
        status: "active";
        shopifyRefundStatus: string;
        shopifyRefundId: string | null;
        shopifyRefundError: string | null;
        approvalStatus: string;
        countDate: string;
        replacesEventId: string;
        refundSource: string | null;
      };
      /** Shopify で返金済みの行を直した（Shopify の返金は直していない） */
      shopifyRefundKept: boolean;
      warning: string | null;
    }
  | { ok: false; code: string; message: string };

export const EDIT_REASON_REQUIRED_CODE = "EDIT_REASON_REQUIRED";

/**
 * 「変更」の計画（純関数）: 前の行を無効にし、replaces 付きの新しい行を足す。
 * - Shopify の返金はしない。返金済み（success）の行は、返金の記録（status・id）を新しい行に引き継ぐ（二重に数えない）
 * - 返金の結果が分からない（pending）の行は直せない（先に「返金を確かめる」）
 * - 承認待ちの行を直したら、新しい行も承認待ち。承認済み・対象外はそのまま
 */
export function planAdjustmentEdit(
  old: AdjustmentEventRow & { currency?: string | null },
  input: AdjustmentEditInput,
  ctx: { timeZone: string; now: Date; approvalStatusForNew: string },
): AdjustmentEditPlan {
  if (old.status !== "active") {
    return { ok: false, code: "NOT_ACTIVE", message: "この登録はもう無効です。画面を読み直してください。" };
  }
  // 却下した登録は直せない（承認の設定をオフにしたあとで直すと、新しい行が有効になって数えられてしまう）
  if (String(old.approvalStatus ?? "") === "rejected") {
    return {
      ok: false,
      code: "REJECTED",
      message: "管理者が却下した登録は変更できません。必要なら新しく登録してください。",
    };
  }
  if (String(old.shopifyRefundStatus ?? "") === "pending") {
    return {
      ok: false,
      code: "SHOPIFY_REFUND_PENDING",
      message: "返金の結果が分かっていません（返金処理中）。先に Shopify の管理画面で返金を確かめ、POS の「返金を確かめる」を押してください。",
    };
  }
  const reason = String(input.reason ?? "").trim();
  if (!reason) {
    return { ok: false, code: EDIT_REASON_REQUIRED_CODE, message: "直したわけを入れてください。" };
  }
  const isVoucher = old.eventType === "voucher_change_adjustment";
  let amount = money(input.amount ?? old.amount);
  let voucherFaceValue: number | null = null;
  let voucherAppliedAmount: number | null = null;
  let voucherChangeAmount: number | null = null;
  if (isVoucher) {
    voucherFaceValue = money(input.voucherFaceValue ?? old.voucherFaceValue);
    voucherAppliedAmount = money(input.voucherAppliedAmount ?? old.voucherAppliedAmount);
    voucherChangeAmount = voucherChangeOf(voucherFaceValue, voucherAppliedAmount);
    amount = voucherChangeAmount;
    if (voucherFaceValue <= 0) {
      return { ok: false, code: "INVALID_AMOUNT", message: "商品券の額面を入れてください。" };
    }
  } else if (!(amount > 0)) {
    return { ok: false, code: "INVALID_AMOUNT", message: "金額は 0 より大きくしてください。" };
  }
  // 純正の返金の付け替えは金額を変えられない（返金額と合わなくなる）。手段・メモだけ直す
  if (String(old.refundSource ?? "") === "native" && money(old.amount) !== amount) {
    return {
      ok: false,
      code: "NATIVE_REFUND_AMOUNT_FIXED",
      message: "純正の返金の付け替えは金額を変えられません。返した手段だけ直せます。分け方を変えるときは、無効にしてから登録し直してください。",
    };
  }
  const shopifyRefundKept = String(old.shopifyRefundStatus ?? "") === "success";
  const keepRefundRecord = shopifyRefundKept;
  const today = calendarDateInTimeZone(ctx.now, ctx.timeZone);
  // 商品券は注文の日で数える（T の決定 2026-11-23）ので「今日の分にする」は使わない
  // 純正の返金の付け替えも、純正で返金した日のまま（その日の返金の行から移すため）
  const isNative = String(old.refundSource ?? "") === "native";
  const countDate = input.dateMode === "today" && !isVoucher && !isNative ? today : countDateOf(old, ctx.timeZone);
  const pick = <T,>(v: T | null | undefined, fallback: T | null): T | null => (v === undefined ? fallback : v);
  const create = {
    sourceOrderId: old.sourceOrderId,
    sourceOrderName: old.sourceOrderName ?? null,
    locationId: old.locationId,
    eventType: old.eventType,
    amount,
    currency: old.currency ?? "JPY",
    originalPaymentMethod: isVoucher ? null : pick(input.originalPaymentMethod, old.originalPaymentMethod),
    actualRefundMethod: isVoucher ? null : pick(input.actualRefundMethod, old.actualRefundMethod),
    voucherFaceValue,
    voucherAppliedAmount,
    voucherChangeAmount,
    adjustKind: old.eventType === "receipt_cash_adjustment" ? (pick(input.adjustKind, old.adjustKind) ?? "undo") : null,
    note: pick(input.note, old.note ?? null),
    createdBy: input.by ?? null,
    status: "active" as const,
    // 返金済みなら返金の記録を引き継ぐ（精算は付け替えだけにして二重に数えない）。それ以外は記録だけ
    shopifyRefundStatus: keepRefundRecord ? "success" : "skipped",
    shopifyRefundId: keepRefundRecord ? (old.shopifyRefundId ?? null) : null,
    shopifyRefundError: keepRefundRecord ? null : "変更による登録し直しのため記録のみ",
    approvalStatus: ctx.approvalStatusForNew,
    countDate,
    replacesEventId: old.id,
    refundSource: old.refundSource ?? null,
  };
  let warning: string | null = null;
  if (String(old.refundSource ?? "") === "native") {
    warning = "純正の返金はそのままです。返した手段だけを直しました。";
  } else if (shopifyRefundKept && money(old.amount) !== amount) {
    warning =
      "Shopify の返金の金額は変わりません。金額を直した分は、Shopify の管理画面で返金を直してください（アプリの記録は直しました）。";
  } else if (shopifyRefundKept) {
    warning = "Shopify の返金はそのままです。アプリの記録（返した手段など）だけを直しました。";
  }
  return { ok: true, create, shopifyRefundKept, warning };
}
