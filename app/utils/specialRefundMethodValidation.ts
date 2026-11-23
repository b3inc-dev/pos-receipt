/**
 * 特殊返金の「実際の返金手段」は支払方法マスタ（有効・特殊返金で選べる）からだけ選べる（T 決定 2026-11-22）。
 * POS の選択肢と同じ値（rawGatewayPattern）か、大文字小文字・前後の空白の違いだけを受ける。
 * 前からある登録（マスタから消した手段など）は精算で「未分類」の行に入る（specialRefundOverlayPure）。
 */
export const REFUND_METHOD_NOT_IN_MASTER_CODE = "REFUND_METHOD_NOT_IN_MASTER";

/** 返金手段を選ぶ種別（POS の showPaymentFields と同じ） */
export function eventTypeNeedsRefundMethod(eventType: string): boolean {
  return eventType === "cash_refund" || eventType === "payment_method_override";
}

export type SelectableRefundMethod = { rawGatewayPattern: string; displayLabel?: string | null };

/** 一致したマスタの値（POS の選択肢の value）を返す。無ければ null */
export function findSelectableRefundMethod<T extends SelectableRefundMethod>(
  actualRefundMethod: unknown,
  selectable: T[],
): T | null {
  const key = String(actualRefundMethod ?? "").trim().toLowerCase();
  if (!key) return null;
  return selectable.find((m) => String(m.rawGatewayPattern ?? "").trim().toLowerCase() === key) ?? null;
}

export function refundMethodNotInMasterMessage(actualRefundMethod: unknown): string {
  const shown = String(actualRefundMethod ?? "").trim();
  return shown
    ? `返金手段「${shown}」は支払方法マスタで特殊返金に選べる手段ではありません。管理画面の「支払方法」で登録してから、POS の特殊返金を開き直してください。`
    : "実際の返金手段を選んでください（支払方法マスタで特殊返金に選べる手段から選びます）。";
}
