/**
 * 会計やり直し: サーバーが組み立てた中身（plan）を POS のカートに入れる。
 *
 * Cart API（shopify.cart）は pos.home.modal.render で使える（@shopify/ui-extensions 2025.10）。
 * - カートに商品があるときは混ざらないように止める（clearCart は元に戻せないので使わない）
 * - 商品は 1 つずつ addLineItem（カスタム商品は addCustomSale）。在庫切れの確認で店の人が
 *   やめたときは '' が返るので、その商品は入れなかったものとして数える
 * - 割引は最後に bulkSetLineItemDiscounts でまとめて付ける
 * - お客様・端数の割引・元の注文番号（_ で始まる印は POS には出ない）は、失敗しても続ける
 *
 * cart を引数で受け取るのは、試験で偽物のカートを渡せるようにするため。
 */

export const REDO_FROM_PROPERTY = "_pos_receipt_redo_from";

/** Cart API が無い・カートが空でない・変えられない を先に見る */
export function checkCartReady(cart) {
  if (!cart || typeof cart.addLineItem !== "function") {
    return { ok: false, reason: "no_cart_api" };
  }
  const current = cart.current?.value;
  if (current && current.editable === false) {
    return { ok: false, reason: "not_editable" };
  }
  const count = Array.isArray(current?.lineItems) ? current.lineItems.length : 0;
  if (count > 0) return { ok: false, reason: "not_empty", count };
  return { ok: true };
}

export const CART_NOT_READY_MESSAGES = {
  no_cart_api: "この画面からはカートに入れられません。下書き注文を使うか、POS を最新にしてください。",
  not_editable: "今はカートを変えられません。お会計の画面を閉じてから、もう一度押してください。",
  not_empty:
    "カートに商品が入っています。お会計を済ませるか、カートを空にしてから、もう一度押してください。",
};

/**
 * @param {object} cart shopify.cart
 * @param {object} plan GET /api/orders/:id/redo-cart の plan
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{ ok: boolean, reason?: string, addedCount: number, skipped: string[], failed: string[], notes: string[] }>}
 */
export async function applyRedoCartPlan(cart, plan, onProgress) {
  const ready = checkCartReady(cart);
  if (!ready.ok) {
    return { ok: false, reason: ready.reason, addedCount: 0, skipped: [], failed: [], notes: [] };
  }

  const lines = Array.isArray(plan?.lines) ? plan.lines : [];
  const total = lines.length;
  const discounts = [];
  const skipped = [];
  const failed = [];
  const notes = [];
  let addedCount = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    onProgress?.(i, total);
    let uuid = "";
    try {
      if (line.kind === "custom") {
        uuid = await cart.addCustomSale({
          title: line.title,
          price: line.price,
          quantity: line.quantity,
          taxable: line.taxable !== false,
        });
      } else {
        uuid = await cart.addLineItem(Number(line.variantId), Number(line.quantity));
      }
    } catch (_) {
      failed.push(line.title);
      continue;
    }
    if (!uuid) {
      // 在庫切れの確認で「やめる」を選んだ
      skipped.push(line.title);
      continue;
    }
    addedCount += 1;
    if (line.unitDiscount?.amount) {
      discounts.push({
        lineItemUuid: uuid,
        lineItemDiscount: {
          title: line.unitDiscount.title,
          type: "FixedAmount",
          amount: String(line.unitDiscount.amount),
        },
      });
    }
  }
  onProgress?.(total, total);

  if (addedCount === 0) {
    return { ok: false, reason: "nothing_added", addedCount, skipped, failed, notes };
  }

  if (discounts.length > 0) {
    try {
      await cart.bulkSetLineItemDiscounts(discounts);
    } catch (_) {
      notes.push("割引を付けられませんでした。カートで割引を確かめてください。");
    }
  }

  if (plan?.customerId) {
    try {
      await cart.setCustomer({ id: Number(plan.customerId) });
    } catch (_) {
      notes.push("お客様を設定できませんでした。必要ならカートで設定してください。");
    }
  }

  if (plan?.cartDiscount?.amount && skipped.length === 0 && failed.length === 0) {
    try {
      await cart.applyCartDiscount("FixedAmount", plan.cartDiscount.title, String(plan.cartDiscount.amount));
    } catch (_) {
      notes.push("端数の割引を付けられませんでした。合計を確かめてください。");
    }
  }

  if (plan?.orderName && typeof cart.addCartProperties === "function") {
    try {
      await cart.addCartProperties({ [REDO_FROM_PROPERTY]: String(plan.orderName) });
    } catch (_) {
      /* 印が付かなくてもお会計には困らない */
    }
  }

  return { ok: true, addedCount, skipped, failed, notes };
}

/** モーダルを閉じて POS の画面へ戻る */
export function closeModalToPos() {
  const dm = globalThis?.shopify?.action?.dismissModal;
  if (typeof dm === "function") {
    try {
      dm();
      return true;
    } catch (_) {
      /* 次へ */
    }
  }
  if (typeof globalThis?.close === "function") {
    try {
      globalThis.close();
      return true;
    } catch (_) {
      /* 何もしない */
    }
  }
  return false;
}
