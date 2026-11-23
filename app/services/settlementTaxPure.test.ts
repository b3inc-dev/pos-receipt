/**
 * 税込逆算（印字・精算の主値）のユニットテスト
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitTaxInclusiveToNetAndTax } from "./settlementTaxPure.server";

describe("splitTaxInclusiveToNetAndTax（設定税率の逆算＝正）", () => {
  it("税率 10% で税込 1100 → tax 100 / net 1000", () => {
    const r = splitTaxInclusiveToNetAndTax(1100, 10);
    assert.equal(r.tax, 100);
    assert.equal(r.netSales, 1000);
  });

  it("税率 10% で税込 1000 → 四捨五入で tax 91 / net 909", () => {
    const r = splitTaxInclusiveToNetAndTax(1000, 10);
    assert.equal(r.tax, 91);
    assert.equal(r.netSales, 909);
  });

  it("負の inclusive は 0 扱い", () => {
    const r = splitTaxInclusiveToNetAndTax(-50, 10);
    assert.equal(r.tax, 0);
    assert.equal(r.netSales, 0);
  });

  it("税率 0 なら税 0・全額 net", () => {
    const r = splitTaxInclusiveToNetAndTax(500, 0);
    assert.equal(r.tax, 0);
    assert.equal(r.netSales, 500);
  });
});
