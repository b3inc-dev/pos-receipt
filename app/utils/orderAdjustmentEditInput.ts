/**
 * 「変更」の本文（POS の JSON・管理画面のフォーム）を AdjustmentEditInput に直す。
 * 送られなかった項目は undefined（前の値のまま）。空の文字は null（消す）。
 */
import type { AdjustmentEditInput } from "../services/orderAdjustmentsPure.server";

function optNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function optString(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export function parseAdjustmentEditBody(body: Record<string, unknown>): AdjustmentEditInput {
  return {
    amount: optNumber(body.amount),
    originalPaymentMethod: optString(body.originalPaymentMethod),
    actualRefundMethod: optString(body.actualRefundMethod),
    adjustKind: optString(body.adjustKind),
    voucherFaceValue: optNumber(body.voucherFaceValue),
    voucherAppliedAmount: optNumber(body.voucherAppliedAmount),
    note: optString(body.note),
    dateMode: body.dateMode === "today" ? "today" : "original",
    reason: typeof body.reason === "string" ? body.reason : null,
    by: typeof body.by === "string" && body.by.trim() ? body.by.trim() : null,
  };
}
