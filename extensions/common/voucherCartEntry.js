/**
 * 会計の前に入れる商品券の額面（POS「商品券」タイル → 会計後の画面）。
 * キーはサーバー app/services/voucherCartEntryPure.ts と同じにする。
 * 「_」始まりのカートの項目は、POS の画面・レシートには出ず、注文には書かれる（shopify.dev Cart API）。
 */
export const VOUCHER_CART_FACE_KEY = "_pos_receipt_voucher_face";

/** 会計後の画面が「この端末で額面を入れた」と知るための目印（拡張の storage）。古い目印は使わない */
export const VOUCHER_CART_HINT_KEY = "voucher_cart_entry_hint";
export const VOUCHER_CART_HINT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** 入力 "5,000" → 5000。数でない・0 以下・小数（円なので受けない）は null */
export function parseVoucherFaceInput(value) {
  const s = String(value ?? "").replace(/[,，\s円]/g, "").trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** カートの項目から、入れてある額面（無ければ null） */
export function voucherFaceInCart(cart) {
  const v = cart?.properties?.[VOUCHER_CART_FACE_KEY];
  return v == null ? null : parseVoucherFaceInput(v);
}

export function isHintFresh(hint, now = Date.now()) {
  const at = Number(hint?.at ?? 0);
  return Number.isFinite(at) && at > 0 && now - at <= VOUCHER_CART_HINT_MAX_AGE_MS;
}

/**
 * 会計後の画面に出す一行（店のスタッフ向けのことば）
 * @param {{ status: string, event?: { voucherFaceValue?: number, voucherChangeAmount?: number }, face?: number }} res
 * @returns {{ tone: "success" | "warning" | "critical" | "subdued", text: string } | null} null は何も出さない
 */
export function postPurchaseMessage(res) {
  const yen = (n) => `${Number(n ?? 0).toLocaleString("ja-JP")}円`;
  switch (res?.status) {
    case "created":
      return {
        tone: "success",
        text: `商品券 ${yen(res.event?.voucherFaceValue)}（釣銭 ${yen(res.event?.voucherChangeAmount)}）を登録しました`,
      };
    case "already":
      return {
        tone: "subdued",
        text: `商品券 ${yen(res.event?.voucherFaceValue)}（釣銭 ${yen(res.event?.voucherChangeAmount)}）は登録済みです`,
      };
    case "no_voucher_payment":
      return {
        tone: "warning",
        text: `商品券釣有りの支払いが無いので、商品券 ${yen(res.face)} は登録していません`,
      };
    case "face_too_small":
      return {
        tone: "warning",
        text: `額面 ${yen(res.face)} が商品券で払った額 ${yen(res.applied)} より小さいので、登録していません。「商品券」タイルから額面を確かめて登録してください`,
      };
    case "settlement_confirmed":
      return { tone: "warning", text: "この日の精算はもう確定しているので、商品券は登録していません。「商品券」タイルから登録してください" };
    case "too_late":
      return null;
    case "disabled":
      return { tone: "warning", text: "商品券の登録が管理画面で止められているので、登録していません" };
    case "cancelled":
      return { tone: "warning", text: "キャンセルした注文なので、商品券は登録していません" };
    case "order_unreadable":
      return { tone: "critical", text: "注文を読めませんでした。あとで「商品券」タイルから登録してください" };
    default:
      return null;
  }
}
