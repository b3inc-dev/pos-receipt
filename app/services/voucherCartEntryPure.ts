/**
 * 会計前の商品券額面（カートの見えない項目）の読み書きのきまり。サーバーと試験で使う。
 * POS 側の同じ値は extensions/common/voucherCartEntry.js（キーは同じにする）。
 */

/** カート → 注文 customAttributes のキー。「_」始まりは POS の画面・レシートに出ない */
export const VOUCHER_CART_FACE_KEY = "_pos_receipt_voucher_face";

/** "5000" → 5000。数でない・0 以下・小数 2 桁より細かい値は null */
export function parseVoucherCartFace(value: unknown): number | null {
  const s = String(value ?? "").replace(/[,，\s円]/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function voucherCartFaceFromAttributes(
  attrs: { key?: string | null; value?: string | null }[] | null | undefined,
): number | null {
  if (!Array.isArray(attrs)) return null;
  const hit = attrs.find((a) => a?.key === VOUCHER_CART_FACE_KEY);
  return hit ? parseVoucherCartFace(hit.value) : null;
}

/** 注文ごとに決まった行の id（同じ注文で 2 回作らないため） */
export function voucherCartEventId(orderGidOrId: string): string {
  const digits = String(orderGidOrId ?? "").replace(/\D/g, "");
  return `pos_vc_cart_${digits}`;
}

/**
 * orders/updated の知らせの中身（REST 形の note_attributes）に会計前の額面があるか。
 * あるときだけ注文を読みに行く（ほかの注文では Admin API を呼ばない）。
 */
export function webhookPayloadHasVoucherCartFace(payload: unknown): boolean {
  const attrs = (payload as { note_attributes?: { name?: string; value?: string }[] } | null)?.note_attributes;
  if (!Array.isArray(attrs)) return false;
  return attrs.some((a) => a?.name === VOUCHER_CART_FACE_KEY && parseVoucherCartFace(a?.value) != null);
}
