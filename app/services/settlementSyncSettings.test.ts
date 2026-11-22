/**
 * P0 D-02 — 精算注文（SETTLEMENT）を作るかどうか。保存が無いときは管理画面と同じく ON
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSettlementPrintingApiPrimary,
  shouldCreateSettlementOrder,
} from "./settlementSyncSettings.server";
import {
  DEFAULT_SETTLEMENT_SETTINGS,
  type PrintSettings,
  type SettlementSettings,
} from "../utils/appSettings.server";

const settlementOn: SettlementSettings = {
  ...DEFAULT_SETTLEMENT_SETTINGS,
  orderBasedCreateSettlementOrderEnabled: true,
};

describe("isSettlementPrintingApiPrimary", () => {
  it("未保存は DEFAULT（prefer+settlementPrinting とも true）で primary", () => {
    assert.equal(isSettlementPrintingApiPrimary(undefined), true);
    assert.equal(isSettlementPrintingApiPrimary({}), true);
  });

  it("どちらか OFF なら primary ではない", () => {
    assert.equal(
      isSettlementPrintingApiPrimary({ preferPrintingApi: false }),
      false,
    );
    assert.equal(
      isSettlementPrintingApiPrimary({ settlementPrintingApiEnabled: false }),
      false,
    );
  });
});

describe("shouldCreateSettlementOrder", () => {
  it("印字設定の保存が無い店は作る（管理画面の見た目 = 初めの値 ON と同じ。今の本番の動き）", () => {
    assert.equal(shouldCreateSettlementOrder(settlementOn, undefined), true);
    assert.equal(shouldCreateSettlementOrder(settlementOn, null), true);
    assert.equal(shouldCreateSettlementOrder(settlementOn, {}), true);
  });

  it("Printing 主経路でも createSettlementOrderWhenPrinting が入っていなければ作る", () => {
    assert.equal(
      shouldCreateSettlementOrder(settlementOn, {
        preferPrintingApi: true,
        settlementPrintingApiEnabled: true,
      }),
      true,
    );
  });

  it("明示 true → 作る", () => {
    const saved: Partial<PrintSettings> = {
      preferPrintingApi: true,
      settlementPrintingApiEnabled: true,
      createSettlementOrderWhenPrinting: true,
    };
    assert.equal(shouldCreateSettlementOrder(settlementOn, saved), true);
  });

  it("明示 false（チェックを外して保存）→ 作らない", () => {
    assert.equal(
      shouldCreateSettlementOrder(settlementOn, {
        preferPrintingApi: true,
        settlementPrintingApiEnabled: true,
        createSettlementOrderWhenPrinting: false,
      }),
      false,
    );
    assert.equal(
      shouldCreateSettlementOrder(settlementOn, {
        preferPrintingApi: false,
        createSettlementOrderWhenPrinting: false,
      }),
      false,
    );
  });

  it("orderBasedCreateSettlementOrderEnabled=false は常に作らない", () => {
    const off = {
      ...settlementOn,
      orderBasedCreateSettlementOrderEnabled: false,
    };
    assert.equal(
      shouldCreateSettlementOrder(off, {
        preferPrintingApi: true,
        settlementPrintingApiEnabled: true,
        createSettlementOrderWhenPrinting: true,
      }),
      false,
    );
    assert.equal(shouldCreateSettlementOrder(off, undefined), false);
  });
});
