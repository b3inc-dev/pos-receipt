export type SpecialRefundIdempotencyPayload = {
  shopId: string;
  sourceOrderId: string;
  sourceOrderName?: string | null;
  locationId: string;
  eventType: string;
  amount: number | string | { toString(): string };
  currency: string;
  originalPaymentMethod: string | null;
  actualRefundMethod: string | null;
  adjustKind: string | null;
  note: string | null;
  voucherFaceValue?: number | string | { toString(): string } | null;
  voucherAppliedAmount?: number | string | { toString(): string } | null;
  voucherChangeAmount?: number | string | { toString(): string } | null;
  createdBy?: string | null;
};

function normalizedNullable(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return s || null;
}

function normalizedAmount(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : "NaN";
}

function normalizedNullableAmount(value: unknown): string | null {
  if (value == null || String(value).trim() === "") return null;
  return normalizedAmount(value);
}

/** POS が再送時にも使い回すキーを、既存の主キー空間へ安全に分離する。 */
export function specialRefundEventIdFromIdempotencyKey(value: unknown): string | null {
  const key = String(value ?? "").trim();
  if (!key) return null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return null;
  return `pos_sr_${key}`;
}

/** 同じキーを別内容へ再利用した場合は、既存イベントを返さず競合として止める。 */
export function matchesSpecialRefundIdempotencyPayload(
  event: SpecialRefundIdempotencyPayload,
  expected: SpecialRefundIdempotencyPayload,
): boolean {
  return (
    event.shopId === expected.shopId &&
    event.sourceOrderId === expected.sourceOrderId &&
    normalizedNullable(event.sourceOrderName) === normalizedNullable(expected.sourceOrderName) &&
    event.locationId === expected.locationId &&
    event.eventType === expected.eventType &&
    normalizedAmount(event.amount) === normalizedAmount(expected.amount) &&
    event.currency === expected.currency &&
    normalizedNullable(event.originalPaymentMethod) ===
      normalizedNullable(expected.originalPaymentMethod) &&
    normalizedNullable(event.actualRefundMethod) ===
      normalizedNullable(expected.actualRefundMethod) &&
    normalizedNullable(event.adjustKind) === normalizedNullable(expected.adjustKind) &&
    normalizedNullable(event.note) === normalizedNullable(expected.note) &&
    normalizedNullableAmount(event.voucherFaceValue) ===
      normalizedNullableAmount(expected.voucherFaceValue) &&
    normalizedNullableAmount(event.voucherAppliedAmount) ===
      normalizedNullableAmount(expected.voucherAppliedAmount) &&
    normalizedNullableAmount(event.voucherChangeAmount) ===
      normalizedNullableAmount(expected.voucherChangeAmount) &&
    normalizedNullable(event.createdBy) === normalizedNullable(expected.createdBy)
  );
}
