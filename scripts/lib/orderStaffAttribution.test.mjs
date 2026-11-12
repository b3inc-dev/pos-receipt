/**
 * 確定済み取引の担当順、部分返品、明示訂正、再送、連携形式の合成データ試験。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  STAFF_ATTRIBUTION_PRODUCTION_CONNECTION_ENABLED,
  applyOrderStaffCorrection,
  attributionFromConfirmedLine,
  buildStaffAttributionPayload,
  createMemoryAttributionStore,
  dispatchStaffAttributionPayload,
  mergeSavedLine,
  planOrderStaffCorrection,
} from "../../extensions/common/orderStaffAttribution.js";

const ORDER_ID = "1001";
const LINE_ID = "gid://shopify/LineItem/55";

function savedOrder(slices) {
  return {
    sequenceKnown: true,
    quantity: slices.reduce((sum, slice) => sum + slice.quantity, 0),
    slices,
  };
}

describe("確定済み明細の担当と返品", () => {
  it("追加順の残数がある先頭担当から部分返品を割り当てる", () => {
    const view = attributionFromConfirmedLine(
      { id: LINE_ID, quantity: 5, refundableQuantity: 2, staffMemberName: "田中" },
      savedOrder([
        { staffId: 101, quantity: 2 },
        { staffId: 202, quantity: 3 },
      ]),
    );
    assert.equal(view.sequenceKnown, true);
    assert.deepEqual(view.returnAllocations, [
      { sequence: 1, staffId: 101, quantity: 2 },
      { sequence: 2, staffId: 202, quantity: 1 },
    ]);
    assert.equal(view.slices[0].remainingQuantity, 0);
    assert.equal(view.slices[1].remainingQuantity, 2);
    assert.equal(view.slices[0].sequence < view.slices[1].sequence, true);
  });

  it("順序不明の旧取引は表示名から順を作らず、返品も担当へ割り当てない", () => {
    const view = attributionFromConfirmedLine(
      { id: LINE_ID, quantity: 5, refundableQuantity: 2, staffMemberName: "田中" },
      null,
    );
    assert.equal(view.sequenceKnown, false);
    assert.deepEqual(view.slices, []);
    assert.deepEqual(view.returnAllocations, []);
    assert.equal(view.returnedQuantity, 3);
  });

  it("明示訂正のあとだけ返品帰属が決まり、再送は一度だけ反映される", async () => {
    const store = createMemoryAttributionStore();
    const unknown = attributionFromConfirmedLine(
      { id: LINE_ID, quantity: 4, refundableQuantity: 3 },
      null,
    );
    const plan = planOrderStaffCorrection({
      orderId: ORDER_ID,
      lineId: LINE_ID,
      quantity: 4,
      returnedQuantity: 1,
      recordedAt: "2026-11-12T00:00:00.000Z",
      idempotencyKey: "corr-1",
      previous: unknown,
      slices: [
        { staffId: 101, quantity: 1 },
        { staffId: null, quantity: 1 },
        { staffId: "gid://shopify/StaffMember/202", quantity: 2 },
      ],
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.record.before.sequenceKnown, false);
    assert.deepEqual(plan.record.after.returnAllocations, [
      { sequence: 1, staffId: 101, quantity: 1 },
    ]);
    assert.deepEqual(plan.effects, {
      payment: "unchanged",
      refund: "unchanged",
      inventory: "unchanged",
    });

    const first = await applyOrderStaffCorrection(store, plan);
    const second = await applyOrderStaffCorrection(store, plan);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.record.recordedAt, "2026-11-12T00:00:00.000Z");
    assert.equal(second.record.after.slices.reduce((sum, slice) => sum + slice.quantity, 0), 4);
    assert.equal(await store.findByKey("corr-1"), first.record);

    const named = planOrderStaffCorrection({
      orderId: ORDER_ID,
      lineId: LINE_ID,
      quantity: 4,
      returnedQuantity: 1,
      recordedAt: "2026-11-12T00:00:00.000Z",
      idempotencyKey: "corr-2",
      previous: null,
      slices: [{ staffId: "田中", quantity: 4 }],
    });
    assert.equal(named.ok, false);
    assert.equal(named.code, "staff_unverified");
  });
});

describe("公開アプリ内で完結する受入", () => {
  it("外部送信がなくても記録、初期割当、訂正、再表示ができる", async () => {
    const store = createMemoryAttributionStore();
    const orderLine = { id: LINE_ID, quantity: 5, refundableQuantity: 2, staffMemberName: "田中" };
    const recorded = planOrderStaffCorrection({
      orderId: ORDER_ID,
      lineId: LINE_ID,
      quantity: 5,
      returnedQuantity: 3,
      recordedAt: "2026-11-12T01:00:00.000Z",
      idempotencyKey: "accept-1",
      previous: null,
      slices: [
        { staffId: 101, quantity: 2 },
        { staffId: 202, quantity: 3 },
      ],
    });
    const saved = await applyOrderStaffCorrection(store, recorded);
    assert.equal(saved.ok, true);
    const initial = attributionFromConfirmedLine(orderLine, saved.record.after);
    assert.deepEqual(initial.returnAllocations, [
      { sequence: 1, staffId: 101, quantity: 2 },
      { sequence: 2, staffId: 202, quantity: 1 },
    ]);

    const corrected = planOrderStaffCorrection({
      orderId: ORDER_ID,
      lineId: LINE_ID,
      quantity: 5,
      returnedQuantity: 3,
      recordedAt: "2026-11-12T02:00:00.000Z",
      idempotencyKey: "accept-2",
      previous: saved.record.after,
      slices: [
        { staffId: 202, quantity: 1 },
        { staffId: 101, quantity: 4 },
      ],
    });
    const correctedSaved = await applyOrderStaffCorrection(store, corrected);
    const shown = mergeSavedLine([], correctedSaved.record.after);
    const redisplayed = attributionFromConfirmedLine(orderLine, shown[0]);
    assert.equal(redisplayed.sequenceKnown, true);
    assert.deepEqual(redisplayed.returnAllocations, [
      { sequence: 1, staffId: 202, quantity: 1 },
      { sequence: 2, staffId: 101, quantity: 2 },
    ]);
    assert.equal(dispatchStaffAttributionPayload(buildStaffAttributionPayload(ORDER_ID, [redisplayed])).required, false);
    assert.equal(await store.findByKey("accept-1") != null, true);
  });
});

describe("連携形式", () => {
  it("合成データは形式を満たし、本番接続では送られない", () => {
    const view = attributionFromConfirmedLine(
      { id: LINE_ID, quantity: 5, refundableQuantity: 2 },
      savedOrder([
        { staffId: 101, quantity: 2 },
        { staffId: 202, quantity: 3 },
      ]),
    );
    const payload = buildStaffAttributionPayload(ORDER_ID, [view]);
    assert.equal(payload.format, "order-staff-attribution");
    assert.equal(payload.formatVersion, 1);
    assert.equal(payload.productionConnection, false);
    assert.equal(payload.lines[0].sequenceKnown, true);
    assert.equal(payload.lines[0].slices[0].sequence, 1);
    assert.deepEqual(payload.effects, {
      payment: "unchanged",
      refund: "unchanged",
      inventory: "unchanged",
    });
    const delivery = dispatchStaffAttributionPayload(payload);
    assert.equal(delivery.sent, false);
    assert.equal(delivery.reason, "production_connection_disabled");
    assert.equal(STAFF_ATTRIBUTION_PRODUCTION_CONNECTION_ENABLED, false);

    const route = readFileSync(
      new URL("../../app/routes/api.orders.$orderId.staff-attribution.tsx", import.meta.url),
      "utf8",
    );
    for (const forbidden of ["admin.graphql", "refundCreate", "inventoryAdjust", "orderCapture", "unauthenticated"]) {
      assert.equal(route.includes(forbidden), false, forbidden);
    }
  });
});
