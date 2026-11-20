/**
 * P0 D-02 — Printing API 優先時の SETTLEMENT 注文作成スキップ／アーカイブオプトイン
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
  it("Printing 主経路かつ createSettlementOrderWhenPrinting 未保存 → スキップ", () => {
    assert.equal(shouldCreateSettlementOrder(settlementOn, undefined), false);
    assert.equal(
      shouldCreateSettlementOrder(settlementOn, {
        preferPrintingApi: true,
        settlementPrintingApiEnabled: true,
      }),
      false,
    );
  });

  it("Printing 主経路かつ明示 true → アーカイブオプトインで作成", () => {
    const saved: Partial<PrintSettings> = {
      preferPrintingApi: true,
      settlementPrintingApiEnabled: true,
      createSettlementOrderWhenPrinting: true,
    };
    assert.equal(shouldCreateSettlementOrder(settlementOn, saved), true);
  });

  it("Printing 主経路かつ明示 false → スキップ", () => {
    const saved: Partial<PrintSettings> = {
      preferPrintingApi: true,
      settlementPrintingApiEnabled: true,
      createSettlementOrderWhenPrinting: false,
    };
    assert.equal(shouldCreateSettlementOrder(settlementOn, saved), false);
  });

  it("Printing 非主経路では未保存でも従来どおり作成（!== false）", () => {
    assert.equal(
      shouldCreateSettlementOrder(settlementOn, {
        preferPrintingApi: false,
        settlementPrintingApiEnabled: true,
      }),
      true,
    );
  });

  it("orderBasedCreateSettlementOrderEnabled=false は常にスキップ", () => {
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
  });
});
