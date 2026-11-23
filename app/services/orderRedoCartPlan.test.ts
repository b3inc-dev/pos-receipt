import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRedoCartPlan,
  normalizeOrderRedoMethod,
  resolveOrderRedoOptions,
  numericIdFromGid,
  REDO_DISCOUNT_TITLE,
  REDO_REMAINDER_TITLE,
  type RedoCartSourceLine,
} from "./orderRedoCartPlan";

const money = (amount: string, currencyCode = "JPY") => ({ shopMoney: { amount, currencyCode } });

function line(p: {
  title?: string;
  qty: number;
  unit: string;
  variant?: { id: string; price?: string } | null;
  discounts?: { amount: string; title?: string; code?: string }[];
  taxable?: boolean;
}): RedoCartSourceLine {
  return {
    title: p.title ?? "商品",
    quantity: p.qty,
    taxable: p.taxable ?? true,
    variant: p.variant === undefined ? { id: "gid://shopify/ProductVariant/11", price: p.unit } : p.variant,
    originalUnitPriceSet: money(p.unit),
    discountAllocations: (p.discounts ?? []).map((d) => ({
      allocatedAmountSet: money(d.amount),
      discountApplication: { title: d.title ?? null, code: d.code ?? null },
    })),
  };
}

describe("resolveOrderRedoOptions", () => {
  it("both / cart / draft で出すボタンが変わる", () => {
    assert.deepEqual(resolveOrderRedoOptions({ enableOrderRedoDraft: true, orderRedoMethod: "both" }, true), {
      canRedoToCart: true,
      canRedoAsDraft: true,
    });
    assert.deepEqual(resolveOrderRedoOptions({ enableOrderRedoDraft: true, orderRedoMethod: "cart" }, true), {
      canRedoToCart: true,
      canRedoAsDraft: false,
    });
    assert.deepEqual(resolveOrderRedoOptions({ enableOrderRedoDraft: true, orderRedoMethod: "draft" }, true), {
      canRedoToCart: false,
      canRedoAsDraft: true,
    });
  });
  it("昔の保存値（方法が無い）は両方、OFF や対象外の注文は出さない", () => {
    assert.deepEqual(resolveOrderRedoOptions({ enableOrderRedoDraft: true }, true), {
      canRedoToCart: true,
      canRedoAsDraft: true,
    });
    assert.deepEqual(resolveOrderRedoOptions({ enableOrderRedoDraft: false, orderRedoMethod: "both" }, true), {
      canRedoToCart: false,
      canRedoAsDraft: false,
    });
    assert.deepEqual(resolveOrderRedoOptions({ enableOrderRedoDraft: true, orderRedoMethod: "both" }, false), {
      canRedoToCart: false,
      canRedoAsDraft: false,
    });
    assert.equal(normalizeOrderRedoMethod("xxx"), "both");
  });
});

describe("buildRedoCartPlan", () => {
  it("割引なし: そのまま入れて割引は付けない", () => {
    const plan = buildRedoCartPlan({
      name: "#1001",
      currencyCode: "JPY",
      customer: { id: "gid://shopify/Customer/777" },
      lineItems: { nodes: [line({ qty: 2, unit: "1100" })] },
    });
    assert.equal(plan.customerId, 777);
    assert.deepEqual(plan.lines, [
      { kind: "variant", variantId: 11, quantity: 2, title: "商品", unitDiscount: null },
    ]);
    assert.equal(plan.cartDiscount, null);
    assert.equal(plan.expectedTotal, "2200");
  });

  it("割引: 1個あたりで割り切れない分はカート全体の端数割引にする（合計は元と同じ）", () => {
    const plan = buildRedoCartPlan({
      name: "#1002",
      currencyCode: "JPY",
      lineItems: { nodes: [line({ qty: 3, unit: "1000", discounts: [{ amount: "100", title: "スタッフ割" }] })] },
    });
    assert.deepEqual(plan.lines[0], {
      kind: "variant",
      variantId: 11,
      quantity: 3,
      title: "商品",
      unitDiscount: { title: "スタッフ割", amount: "33" },
    });
    assert.deepEqual(plan.cartDiscount, { title: REDO_REMAINDER_TITLE, amount: "1" });
    assert.equal(plan.expectedTotal, "2900");
  });

  it("今の値段が上がっていたら、差を割引にして元の額に合わせる", () => {
    const plan = buildRedoCartPlan({
      currencyCode: "JPY",
      lineItems: {
        nodes: [line({ qty: 1, unit: "1000", variant: { id: "gid://shopify/ProductVariant/5", price: "1200" } })],
      },
    });
    assert.deepEqual(plan.lines[0].unitDiscount, { title: REDO_DISCOUNT_TITLE, amount: "200" });
    assert.equal(plan.expectedTotal, "1000");
    assert.equal(plan.warnings.length, 0);
  });

  it("今の値段が下がっていたら、今の値段で入れて知らせる", () => {
    const plan = buildRedoCartPlan({
      currencyCode: "JPY",
      lineItems: {
        nodes: [line({ title: "T シャツ", qty: 1, unit: "1000", variant: { id: "gid://shopify/ProductVariant/5", price: "800" } })],
      },
    });
    assert.equal(plan.lines[0].unitDiscount, null);
    assert.equal(plan.expectedTotal, "800");
    assert.deepEqual(plan.warnings, [{ code: "price_lower_now", title: "T シャツ", difference: "200" }]);
  });

  it("削除された商品はカスタム商品（元の単価・課税）で入れる", () => {
    const plan = buildRedoCartPlan({
      currencyCode: "JPY",
      lineItems: { nodes: [line({ title: "旧商品", qty: 2, unit: "500", variant: null, taxable: false })] },
    });
    assert.deepEqual(plan.lines[0], {
      kind: "custom",
      title: "旧商品",
      price: "500",
      quantity: 2,
      taxable: false,
      unitDiscount: null,
    });
    assert.deepEqual(plan.warnings, [{ code: "deleted_product", title: "旧商品" }]);
  });

  it("同じバリアントの行はまとめる（POS では同じ商品が 1 行にまとまるため）", () => {
    const plan = buildRedoCartPlan({
      currencyCode: "JPY",
      lineItems: {
        nodes: [
          line({ qty: 1, unit: "1000", discounts: [{ amount: "100", title: "A" }] }),
          line({ qty: 1, unit: "1000" }),
          line({ qty: 0, unit: "1000" }),
        ],
      },
    });
    assert.equal(plan.lines.length, 1);
    assert.equal(plan.lines[0].quantity, 2);
    assert.deepEqual(plan.lines[0].unitDiscount, { title: "A", amount: "50" });
    assert.equal(plan.expectedTotal, "1900");
    assert.equal(plan.skippedLineCount, 1);
  });

  it("小数のある通貨は 2 桁で扱う", () => {
    const plan = buildRedoCartPlan({
      currencyCode: "USD",
      lineItems: { nodes: [{ ...line({ qty: 3, unit: "10.00", discounts: [{ amount: "1.00", code: "SAVE" }] }) }] },
    });
    assert.deepEqual(plan.lines[0].unitDiscount, { title: "SAVE", amount: "0.33" });
    assert.deepEqual(plan.cartDiscount, { title: REDO_REMAINDER_TITLE, amount: "0.01" });
    assert.equal(plan.expectedTotal, "29.00");
  });

  it("numericIdFromGid", () => {
    assert.equal(numericIdFromGid("gid://shopify/ProductVariant/123"), 123);
    assert.equal(numericIdFromGid(null), null);
  });
});
