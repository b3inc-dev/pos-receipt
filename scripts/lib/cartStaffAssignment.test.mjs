/**
 * カート担当の合成データ試験。
 * 一括設定、明細変更、数量分割、未割当、行削除、決済中止のあと、
 * 残明細の担当と数量が期待値と一致することを確認する。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CART_STAFF_EXTERNAL_SEND_ENABLED,
  allocationKey,
  applyCartStaffMutations,
  createCartStaffState,
  externalStaffDispatch,
  parseStableStaffId,
  buildCartStaffRecord,
  draftLinesForOrder,
  slicesToRecord,
  mergeStaffRoster,
  overlayFromDraft,
  planDraftRestore,
  reconcileStaffLine,
  reduceCartStaff,
  restoreCartStaffRecord,
  rosterFromSessionAndLines,
  runCartStaffAction,
} from "../../extensions/common/cartStaffAssignment.js";
import {
  attributionFromConfirmedLine,
  commitOrderStaffCorrection,
  createMemoryAttributionStore,
  mergeSavedLine,
} from "../../extensions/common/orderStaffAttribution.js";

const ROSTER = [{ id: 101 }, { id: 202 }];

function line(overrides) {
  return {
    uuid: overrides.uuid,
    title: overrides.title ?? overrides.uuid,
    variantId: overrides.variantId,
    quantity: overrides.quantity,
    quantityValid: true,
    staffId: overrides.staffId ?? null,
    staffState: overrides.staffState ?? (overrides.staffId ? "assigned" : "unassigned"),
    discounts: overrides.discounts ?? 0,
    propertyCount: overrides.propertyCount ?? 0,
    hasSellingPlan: overrides.hasSellingPlan ?? false,
  };
}

function applyStep(state, action) {
  const result = reduceCartStaff(state, action, ROSTER);
  assert.equal(result.ok, true, result.code);
  assert.equal(result.externalSent, false);
  return result;
}

describe("POSカート明細の読み取り", () => {
  it("attributedUserId だけを担当にし、表示名プロパティは担当にしない", () => {
    const state = createCartStaffState([
      {
        uuid: "shirt",
        title: "シャツ",
        variantId: 11,
        quantity: 2,
        attributedUserId: 101,
        properties: { staffName: "田中" },
        discounts: [],
      },
      {
        uuid: "cap",
        title: "帽子",
        variantId: 33,
        quantity: 1,
        attributedUserId: "田中",
      },
    ]);
    assert.equal(state.lines[0].staffId, 101);
    assert.equal(state.lines[0].staffState, "assigned");
    assert.equal(state.lines[0].propertyCount, 1);
    assert.equal(state.lines[1].staffState, "unclassified");
    assert.equal(state.lines[1].staffId, null);
  });
});

describe("parseStableStaffId", () => {
  it("数値IDとスタッフGIDだけを受け、表示名は捨てる", () => {
    assert.equal(parseStableStaffId(101), 101);
    assert.equal(parseStableStaffId("202"), 202);
    assert.equal(parseStableStaffId("gid://shopify/StaffMember/303"), 303);
    assert.equal(parseStableStaffId("田中"), null);
    assert.equal(parseStableStaffId("gid://shopify/User/101"), null);
    assert.equal(parseStableStaffId(0), null);
    assert.equal(parseStableStaffId(null), null);
  });
});

describe("合成カートの担当", () => {
  it("一括、部分数量、担当変更、行削除、決済中止のあと残明細が期待値と一致する", () => {
    let state = createCartStaffState([
      line({ uuid: "shirt", variantId: 11, quantity: 3 }),
      line({ uuid: "bag", variantId: 22, quantity: 1, staffId: 101 }),
      line({
        uuid: "cap",
        variantId: 33,
        quantity: 2,
        staffId: null,
        staffState: "unclassified",
      }),
    ]);
    const beforeQty = state.lines.reduce((sum, item) => sum + item.quantity, 0);

    const blocked = reduceCartStaff(state, { type: "assign_cart", staffId: 101 }, ROSTER);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "cart_unclassified");
    assert.equal(allocationKey(blocked.state.lines), allocationKey(state.lines));

    const classified = applyStep(state, { type: "assign_line", lineUuid: "cap", staffId: 101 });
    state = classified.state;
    assert.equal(state.lines.find((item) => item.uuid === "cap").staffId, 101);

    const bulk = applyStep(state, { type: "assign_cart", staffId: 101 });
    state = bulk.state;
    assert.deepEqual(
      state.lines.map((item) => item.staffId),
      [101, 101, 101],
    );
    assert.deepEqual(bulk.mutations, [{ op: "set_cart_staff", staffId: 101 }]);

    const again = applyStep(state, { type: "assign_cart", staffId: 101 });
    assert.deepEqual(again.mutations, []);
    assert.equal(allocationKey(again.state.lines), allocationKey(state.lines));

    const split = applyStep(state, {
      type: "assign_partial",
      lineUuid: "shirt",
      quantity: 1,
      staffId: null,
    });
    state = split.state;
    assert.equal(split.mutations[0].op, "split_variant");
    assert.equal(
      state.lines.filter((item) => item.variantId === 11).reduce((sum, item) => sum + item.quantity, 0),
      3,
    );

    const changed = applyStep(state, { type: "assign_line", lineUuid: "bag", staffId: 202 });
    state = changed.state;
    const removed = applyStep(state, { type: "remove_line", lineUuid: "cap" });
    state = removed.state;
    const cancelled = applyStep(state, { type: "cancel_checkout" });
    state = cancelled.state;

    assert.equal(cancelled.mutations.length, 0);
    assert.equal(state.checkout, "cancelled");
    assert.deepEqual(
      state.lines
        .map((item) => ({
          variantId: item.variantId,
          quantity: item.quantity,
          staffId: item.staffId,
          staffState: item.staffState,
        }))
        .sort((a, b) => a.quantity - b.quantity || a.variantId - b.variantId),
      [
        { variantId: 11, quantity: 1, staffId: null, staffState: "unassigned" },
        { variantId: 22, quantity: 1, staffId: 202, staffState: "assigned" },
        { variantId: 11, quantity: 2, staffId: 101, staffState: "assigned" },
      ],
    );
    assert.equal(
      state.lines.reduce((sum, item) => sum + item.quantity, 0),
      beforeQty - 2,
    );
    assert.equal(externalStaffDispatch(state).sent, false);
  });

  it("表示名では割り当てず、割引付き明細の数量分割もしない", () => {
    const state = createCartStaffState([
      line({ uuid: "shirt", variantId: 11, quantity: 4, discounts: 1 }),
    ]);
    const byName = reduceCartStaff(
      state,
      { type: "assign_line", lineUuid: "shirt", staffId: "田中" },
      ROSTER,
    );
    assert.equal(byName.ok, false);
    assert.equal(byName.code, "staff_unverified");
    assert.equal(byName.state.lines[0].quantity, 4);

    const partial = reduceCartStaff(
      state,
      { type: "assign_partial", lineUuid: "shirt", quantity: 1, staffId: 101 },
      ROSTER,
    );
    assert.equal(partial.ok, false);
    assert.equal(partial.code, "split_blocked");
    assert.equal(partial.mutations.length, 0);
    assert.equal(partial.state.lines.length, 1);

    const whole = reduceCartStaff(
      state,
      { type: "assign_line", lineUuid: "shirt", staffId: 202 },
      ROSTER,
    );
    assert.equal(whole.ok, true);
    assert.equal(whole.state.lines[0].quantity, 4);
    assert.equal(whole.state.lines[0].staffId, 202);
  });

  it("ログイン中のスタッフIDだけを名簿に入れ、ユーザーIDは使わない", () => {
    const roster = rosterFromSessionAndLines(
      { staffMemberId: "gid://shopify/StaffMember/101", userId: 999 },
      [{ staffId: 202 }],
    );
    assert.equal(roster.pinnedStaffId, 101);
    assert.deepEqual(
      roster.roster.map((entry) => entry.id).sort(),
      [101, 202],
    );
    assert.equal(roster.roster.some((entry) => entry.id === 999), false);
  });
});

describe("標準の担当設定が使えないカート", () => {
  it("担当IDが空でもAとBを数量ごとに記録し、決済後に同じ順で戻せる", async () => {
    const roster = mergeStaffRoster([], [
      { key: "app:staffaaaa", label: "A" },
      { key: "app:staffbbbb", label: "B" },
    ]);
    const state = createCartStaffState([
      { uuid: "shirt", title: "シャツ", variantId: 11, quantity: 5 },
    ]);
    const cart = {
      calls: [],
      async setAttributedStaff() {
        this.calls.push("setAttributedStaff");
      },
      async setAttributedStaffToLineItem() {
        this.calls.push("setAttributedStaffToLineItem");
      },
    };
    const partial = await runCartStaffAction(
      state.lines,
      { type: "assign_partial", lineUuid: "shirt", quantity: 2, staffId: "app:staffaaaa" },
      roster,
      cart,
    );
    assert.equal(partial.ok, true);
    const recorded = await runCartStaffAction(
      partial.state.lines,
      { type: "assign_partial", lineUuid: "shirt", quantity: 3, staffId: "app:staffbbbb" },
      roster,
      cart,
    );
    assert.equal(recorded.ok, true);
    assert.deepEqual(cart.calls, []);
    assert.equal(recorded.state.lines.length, 1);
    assert.equal(recorded.state.lines[0].quantity, 5);
    const draft = buildCartStaffRecord(recorded.state.lines);
    const restored = restoreCartStaffRecord(
      [{ id: "line-1", variantId: "gid://shopify/ProductVariant/11", quantity: 5, title: "別の名前" }],
      draft.lines,
    );
    assert.deepEqual(restored.unmatched, []);
    assert.deepEqual(
      restored.restored[0].slices.filter((slice) => slice.staffState === "assigned").map((slice) => ({
        staffKey: slice.staffKey,
        quantity: slice.quantity,
      })),
      [
        { staffKey: "app:staffaaaa", quantity: 2 },
        { staffKey: "app:staffbbbb", quantity: 3 },
      ],
    );
    const view = attributionFromConfirmedLine(
      { id: "line-1", quantity: 5, refundableQuantity: 2 },
      restored.restored[0],
    );
    assert.equal(view.returnAllocations[0].staffKey, "app:staffaaaa");
    assert.equal(view.returnAllocations[0].quantity, 2);
    assert.equal(view.returnAllocations[1].staffKey, "app:staffbbbb");
    const store = createMemoryAttributionStore();
    const saved = await commitOrderStaffCorrection(store, {
      orderId: "1001",
      lineId: "line-1",
      quantity: 5,
      returnedQuantity: 3,
      recordedAt: "2026-11-12T04:00:00.000Z",
      idempotencyKey: "restore-1",
      slices: restored.restored[0].slices.filter((slice) => slice.staffState === "assigned"),
    });
    const corrected = await commitOrderStaffCorrection(store, {
      orderId: "1001",
      lineId: "line-1",
      quantity: 5,
      returnedQuantity: 3,
      recordedAt: "2026-11-12T05:00:00.000Z",
      idempotencyKey: "restore-2",
      slices: [
        { staffKey: "app:staffbbbb", quantity: 1 },
        { staffKey: "app:staffaaaa", quantity: 4 },
      ],
    });
    const shown = attributionFromConfirmedLine(
      { id: "line-1", quantity: 5, refundableQuantity: 2 },
      mergeSavedLine([], corrected.record.after)[0],
    );
    assert.equal(shown.returnAllocations[0].staffKey, "app:staffbbbb");
    assert.equal(shown.returnAllocations[0].quantity, 1);
    assert.equal(saved.record.after.slices[0].staffKey, "app:staffaaaa");

    const raw = createCartStaffState([
      { uuid: "shirt", title: "シャツ", variantId: 11, quantity: 5 },
    ]).lines[0];
    const first = partial.state.lines[0];
    const continued = reduceCartStaff(
      { checkout: "open", lines: [reconcileStaffLine(raw, first)] },
      { type: "assign_partial", lineUuid: "shirt", quantity: 3, staffId: "app:staffbbbb" },
      roster,
    );
    assert.equal(continued.ok, true);
    assert.deepEqual(
      continued.state.lines[0].slices.filter((slice) => slice.staffState === "assigned").map((slice) => ({
        staffKey: slice.staffKey,
        quantity: slice.quantity,
      })),
      [
        { staffKey: "app:staffaaaa", quantity: 2 },
        { staffKey: "app:staffbbbb", quantity: 3 },
      ],
    );

    const partialOnly = slicesToRecord({
      slices: [
        { staffKey: "app:staffaaaa", staffState: "assigned", quantity: 2 },
        { staffId: null, staffState: "unassigned", quantity: 3 },
      ],
    });
    assert.equal(partialOnly.reduce((sum, slice) => sum + slice.quantity, 0), 5);
    const mixed = buildCartStaffRecord([
      { uuid: "open", variantId: 11, quantity: 5, quantityValid: true, staffState: "unclassified" },
      continued.state.lines[0],
    ]);
    assert.equal(mixed.lines[0].placeholder, true);
    const aligned = restoreCartStaffRecord(
      [
        { id: "open-line", variantId: 11, quantity: 5 },
        { id: "assigned-line", variantId: 11, quantity: 5 },
      ],
      mixed.lines,
    );
    assert.deepEqual(aligned.unmatched, ["open-line"]);
    assert.equal(aligned.restored[0].lineId, "assigned-line");
    assert.equal(aligned.restored[0].slices.some((slice) => slice.staffKey === "app:staffaaaa"), true);
    const otherOrder = restoreCartStaffRecord(
      [{ id: "other", variantId: 11, quantity: 5 }],
      draftLinesForOrder({ boundOrderId: "1001", lines: mixed.lines }, "2002"),
    );
    assert.deepEqual(otherOrder.restored, []);
  });
});

describe("標準担当の数量分割と再表示", () => {
  it("分割後の担当順は各明細の数量と一致し、開き直してもアプリ担当を戻せる", () => {
    const roster = [{ id: 101 }, { id: 202 }];
    const initial = createCartStaffState([
      { uuid: "shirt", title: "シャツ", variantId: 11, quantity: 5 },
    ]);
    const assigned = reduceCartStaff(
      initial,
      { type: "assign_line", lineUuid: "shirt", staffId: 101 },
      roster,
    );
    const split = reduceCartStaff(
      assigned.state,
      { type: "assign_partial", lineUuid: "shirt", quantity: 2, staffId: 202 },
      roster,
    );
    assert.equal(split.ok, true);
    const record = buildCartStaffRecord(split.state.lines);
    assert.deepEqual(record.lines.map((line) => ({
      quantity: line.quantity,
      staffId: line.slices[0].staffId,
      sliceQuantity: line.slices[0].quantity,
    })), [
      { quantity: 3, staffId: 101, sliceQuantity: 3 },
      { quantity: 2, staffId: 202, sliceQuantity: 2 },
    ]);

    const appRoster = mergeStaffRoster([], [
      { key: "app:staffaaaa", label: "A" },
      { key: "app:staffbbbb", label: "B" },
    ]);
    const first = reduceCartStaff(
      initial,
      { type: "assign_partial", lineUuid: "shirt", quantity: 2, staffId: "app:staffaaaa" },
      appRoster,
    );
    const draft = buildCartStaffRecord(first.state.lines);
    const reopened = createCartStaffState([
      { uuid: "shirt", title: "シャツ", variantId: 11, quantity: 5 },
    ]).lines;
    const overlay = overlayFromDraft(reopened, draft.lines);
    const continued = reduceCartStaff(
      { checkout: "open", lines: [overlay.shirt] },
      { type: "assign_partial", lineUuid: "shirt", quantity: 3, staffId: "app:staffbbbb" },
      appRoster,
    );
    assert.equal(continued.ok, true);
    assert.deepEqual(
      continued.state.lines[0].slices.filter((slice) => slice.staffState === "assigned").map((slice) => ({
        staffKey: slice.staffKey,
        quantity: slice.quantity,
      })),
      [
        { staffKey: "app:staffaaaa", quantity: 2 },
        { staffKey: "app:staffbbbb", quantity: 3 },
      ],
    );
  });

  it("現在の標準担当は古い下書きで置き換えず、選び直すとカート操作になる", () => {
    const roster = [{ id: 101 }, { id: 202 }];
    const current = createCartStaffState([
      { uuid: "shirt", title: "シャツ", variantId: 11, quantity: 5, attributedUserId: 202 },
    ]);
    const stale = buildCartStaffRecord(
      reduceCartStaff(
        createCartStaffState([{ uuid: "shirt", title: "シャツ", variantId: 11, quantity: 5 }]),
        { type: "assign_line", lineUuid: "shirt", staffId: 101 },
        roster,
      ).state.lines,
    );
    const overlay = overlayFromDraft(current.lines, stale.lines);
    assert.equal(overlay.shirt, undefined);
    const again = reduceCartStaff(
      current,
      { type: "assign_line", lineUuid: "shirt", staffId: 101 },
      roster,
    );
    assert.equal(again.ok, true);
    assert.equal(again.mutations.length, 1);
    assert.equal(again.mutations[0].staffId, 101);
    assert.equal(
      planDraftRestore({
        localLines: stale.lines,
        remoteLines: [{ uuid: "other" }],
        edited: false,
      }).source,
      "local",
    );
    assert.equal(
      planDraftRestore({ localLines: null, remoteLines: stale.lines, edited: false }).source,
      "remote",
    );
    assert.equal(
      planDraftRestore({ localLines: stale.lines, remoteLines: stale.lines, edited: true }).source,
      "keep",
    );
  });
});

describe("カートAPIへの反映", () => {
  function fakeCart(initial) {
    let seq = 0;
    const lines = initial.map((item) => ({ ...item }));
    const calls = [];
    const note = (name) => calls.push(name);
    return {
      lines,
      calls,
      externalDispatch() {
        note("externalDispatch");
      },
      addLineItemProperties() {
        note("addLineItemProperties");
      },
      async setAttributedStaff(staffId) {
        note("setAttributedStaff");
        for (const line of lines) line.staffId = staffId ?? null;
      },
      async setAttributedStaffToLineItem(staffId, uuid) {
        note("setAttributedStaffToLineItem");
        const line = lines.find((item) => item.uuid === uuid);
        if (!line) throw new Error("missing line");
        line.staffId = staffId ?? null;
      },
      async addLineItem(variantId, quantity) {
        note("addLineItem");
        const uuid = `new-${++seq}`;
        lines.push({ uuid, variantId, quantity, staffId: null });
        return uuid;
      },
      async removeLineItem(uuid) {
        note("removeLineItem");
        const index = lines.findIndex((item) => item.uuid === uuid);
        if (index < 0) throw new Error("missing line");
        lines.splice(index, 1);
      },
    };
  }

  it("部分数量の反映後も数量合計と担当が一致し、外部送信は呼ばれない", async () => {
    const cart = fakeCart([
      { uuid: "shirt", variantId: 11, quantity: 3, staffId: 101 },
    ]);
    const state = createCartStaffState([
      line({ uuid: "shirt", variantId: 11, quantity: 3, staffId: 101 }),
    ]);
    const planned = reduceCartStaff(
      state,
      { type: "assign_partial", lineUuid: "shirt", quantity: 1, staffId: null },
      ROSTER,
    );
    const applied = await applyCartStaffMutations(planned.mutations, cart);
    assert.equal(applied.ok, true);
    assert.equal(
      cart.lines.reduce((sum, item) => sum + item.quantity, 0),
      3,
    );
    assert.equal(cart.lines.filter((item) => item.staffId === 101).reduce((sum, item) => sum + item.quantity, 0), 2);
    assert.equal(cart.lines.filter((item) => item.staffId == null).reduce((sum, item) => sum + item.quantity, 0), 1);
    assert.equal(cart.calls.includes("externalDispatch"), false);
    assert.equal(cart.calls.includes("addLineItemProperties"), false);
    assert.equal(CART_STAFF_EXTERNAL_SEND_ENABLED, false);
  });

  it("未分類の明細は数量を分けず、残数量の担当を未割当にしない", async () => {
    const state = createCartStaffState([
      {
        uuid: "shirt",
        title: "シャツ",
        variantId: 11,
        quantity: 3,
        attributedUserId: "田中",
      },
    ]);
    const cart = fakeCart([
      { uuid: "shirt", variantId: 11, quantity: 3, staffId: null },
    ]);
    const blocked = await runCartStaffAction(
      state.lines,
      { type: "assign_partial", lineUuid: "shirt", quantity: 1, staffId: 101 },
      ROSTER,
      cart,
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "split_unclassified");
    assert.deepEqual(blocked.mutations, []);
    assert.equal(blocked.state.lines.length, 1);
    assert.equal(blocked.state.lines[0].quantity, 3);
    assert.equal(blocked.state.lines[0].staffState, "unclassified");
    assert.deepEqual(cart.calls, []);
    assert.deepEqual(cart.lines, [
      { uuid: "shirt", variantId: 11, quantity: 3, staffId: null },
    ]);

    const assigned = reduceCartStaff(
      state,
      { type: "assign_line", lineUuid: "shirt", staffId: 101 },
      ROSTER,
    );
    assert.equal(assigned.ok, true);
    const partial = reduceCartStaff(
      assigned.state,
      { type: "assign_partial", lineUuid: "shirt", quantity: 1, staffId: null },
      ROSTER,
    );
    assert.equal(partial.ok, true);
    assert.equal(partial.state.lines.find((item) => item.quantity === 2).staffId, 101);
    assert.equal(partial.state.lines.find((item) => item.quantity === 2).staffState, "assigned");
    assert.equal(partial.state.lines.find((item) => item.quantity === 1).staffState, "unassigned");
  });

  it("追加に失敗した分割は元明細を残し、増えた数量を戻す", async () => {
    const cart = fakeCart([
      { uuid: "shirt", variantId: 11, quantity: 3, staffId: 101 },
    ]);
    let adds = 0;
    const originalAdd = cart.addLineItem.bind(cart);
    cart.addLineItem = async (variantId, quantity) => {
      adds += 1;
      if (adds === 2) throw new Error("add failed");
      return originalAdd(variantId, quantity);
    };
    const result = await applyCartStaffMutations(
      [
        {
          op: "split_variant",
          removeUuid: "shirt",
          adds: [
            { variantId: 11, quantity: 2, staffId: 101 },
            { variantId: 11, quantity: 1, staffId: null },
          ],
        },
      ],
      cart,
    );
    assert.equal(result.ok, false);
    assert.deepEqual(cart.lines, [
      { uuid: "shirt", variantId: 11, quantity: 3, staffId: 101 },
    ]);
  });
});
