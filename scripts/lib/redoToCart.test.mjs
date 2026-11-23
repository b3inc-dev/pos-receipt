/**
 * 会計やり直し（カートに入れる）: extensions/common/redoToCart.js を偽物のカートで確かめる。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyRedoCartPlan, checkCartReady, REDO_FROM_PROPERTY } from "../../extensions/common/redoToCart.js";

function fakeCart({ lineItems = [], editable, failVariant, dismissVariant } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    current: { value: { lineItems, editable } },
    async addLineItem(variantId, qty) {
      calls.push(["addLineItem", variantId, qty]);
      if (variantId === failVariant) throw new Error("boom");
      if (variantId === dismissVariant) return "";
      return `uuid-${++n}`;
    },
    async addCustomSale(cs) {
      calls.push(["addCustomSale", cs]);
      return `uuid-${++n}`;
    },
    async bulkSetLineItemDiscounts(d) {
      calls.push(["bulkSetLineItemDiscounts", d]);
    },
    async setCustomer(c) {
      calls.push(["setCustomer", c]);
    },
    async applyCartDiscount(type, title, amount) {
      calls.push(["applyCartDiscount", type, title, amount]);
    },
    async addCartProperties(p) {
      calls.push(["addCartProperties", p]);
    },
  };
}

const PLAN = {
  orderName: "#1001",
  customerId: 777,
  lines: [
    { kind: "variant", variantId: 11, quantity: 3, title: "A", unitDiscount: { title: "スタッフ割", amount: "33" } },
    { kind: "custom", title: "旧商品", price: "500", quantity: 1, taxable: true, unitDiscount: null },
  ],
  cartDiscount: { title: "元の注文の割引（端数）", amount: "1" },
};

describe("checkCartReady", () => {
  it("カートが空でないときは止める", () => {
    assert.deepEqual(checkCartReady(fakeCart({ lineItems: [{ uuid: "x" }] })), {
      ok: false,
      reason: "not_empty",
      count: 1,
    });
  });
  it("変えられないカート・Cart API が無いときも止める", () => {
    assert.equal(checkCartReady(fakeCart({ editable: false })).reason, "not_editable");
    assert.equal(checkCartReady(undefined).reason, "no_cart_api");
  });
});

describe("applyRedoCartPlan", () => {
  it("商品・カスタム商品・割引・お客様・端数・元の注文番号を入れる", async () => {
    const cart = fakeCart();
    const progress = [];
    const res = await applyRedoCartPlan(cart, PLAN, (d, t) => progress.push([d, t]));
    assert.equal(res.ok, true);
    assert.equal(res.addedCount, 2);
    assert.deepEqual(cart.calls, [
      ["addLineItem", 11, 3],
      ["addCustomSale", { title: "旧商品", price: "500", quantity: 1, taxable: true }],
      [
        "bulkSetLineItemDiscounts",
        [{ lineItemUuid: "uuid-1", lineItemDiscount: { title: "スタッフ割", type: "FixedAmount", amount: "33" } }],
      ],
      ["setCustomer", { id: 777 }],
      ["applyCartDiscount", "FixedAmount", "元の注文の割引（端数）", "1"],
      ["addCartProperties", { [REDO_FROM_PROPERTY]: "#1001" }],
    ]);
    assert.deepEqual(progress.at(-1), [2, 2]);
  });

  it("カートに商品があるときは何もしない", async () => {
    const cart = fakeCart({ lineItems: [{ uuid: "x" }] });
    const res = await applyRedoCartPlan(cart, PLAN);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "not_empty");
    assert.equal(cart.calls.length, 0);
  });

  it("在庫切れでやめた・失敗した商品は知らせ、端数の割引は付けない", async () => {
    const cart = fakeCart({ dismissVariant: 11, failVariant: 12 });
    const plan = {
      ...PLAN,
      lines: [
        ...PLAN.lines,
        { kind: "variant", variantId: 12, quantity: 1, title: "C", unitDiscount: null },
      ],
    };
    const res = await applyRedoCartPlan(cart, plan);
    assert.equal(res.ok, true);
    assert.deepEqual(res.skipped, ["A"]);
    assert.deepEqual(res.failed, ["C"]);
    assert.equal(cart.calls.some((c) => c[0] === "applyCartDiscount"), false);
    assert.equal(cart.calls.some((c) => c[0] === "bulkSetLineItemDiscounts"), false);
  });

  it("1 つも入らなければ失敗として返す", async () => {
    const cart = fakeCart({ dismissVariant: 11 });
    const res = await applyRedoCartPlan(cart, { ...PLAN, lines: [PLAN.lines[0]] });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "nothing_added");
  });
});
