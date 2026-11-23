/**
 * 注文メタフィールド pos.adjustments の形と数え方（docs/ORDER_ADJUSTMENTS_METAFIELD.md）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOrderAdjustmentsDoc,
  buildOrderAdjustmentsSummary,
  calendarDateInTimeZone,
  countDateOf,
  entriesForDayAndLocation,
  orderMetafieldStateOf,
  parseOrderAdjustmentsDoc,
  planAdjustmentEdit,
  resolveSettlementAdjustments,
  voucherAppliedFromTransactions,
  voucherChangeOf,
  type AdjustmentEventRow,
} from "./orderAdjustmentsPure.server";

const TZ = "Asia/Tokyo";
const LOC = "gid://shopify/Location/1001";

function row(p: Partial<AdjustmentEventRow> & { id: string }): AdjustmentEventRow {
  return {
    sourceOrderId: "gid://shopify/Order/5001",
    sourceOrderName: "#5001",
    locationId: LOC,
    eventType: "payment_method_override",
    amount: 1200,
    currency: "JPY",
    originalPaymentMethod: "shopify_payments",
    actualRefundMethod: "cash",
    adjustKind: null,
    createdBy: "山田",
    status: "active",
    shopifyRefundStatus: "skipped",
    shopifyRefundId: null,
    approvalStatus: "none",
    countDate: "2026-11-23",
    replacesEventId: null,
    createdAt: new Date("2026-11-23T06:04:00Z"),
    // 初めは「注文に書く設定にしてから書いた注文」
    metafieldSyncedAt: new Date("2026-11-23T06:04:01Z"),
    metafieldSyncError: null,
    ...p,
  };
}

test("日本時間の日付: UTC 15 時（日本の 0 時）からは次の日", () => {
  assert.equal(calendarDateInTimeZone(new Date("2026-11-22T14:59:59Z"), TZ), "2026-11-22");
  assert.equal(calendarDateInTimeZone(new Date("2026-11-22T15:00:00Z"), TZ), "2026-11-23");
});

test("countDate が無い前からの行は、登録した日（日本時間）で数える", () => {
  assert.equal(countDateOf({ countDate: null, createdAt: new Date("2026-11-22T16:00:00Z") }, TZ), "2026-11-23");
  assert.equal(countDateOf({ countDate: "2026-11-20", createdAt: new Date("2026-11-22T16:00:00Z") }, TZ), "2026-11-20");
});

test("値の形: 行は登録した順、置き換えた行には replacedBy、承認待ち・無効の status", () => {
  const labels: Record<string, string> = { cash: "現金", shopify_payments: "クレジット" };
  const doc = buildOrderAdjustmentsDoc(
    [
      row({ id: "b", replacesEventId: "a", amount: 1000, createdAt: new Date("2026-11-23T07:00:00Z") }),
      row({ id: "a", status: "voided", voidReason: "金額の入れ間違い", voidedAt: new Date("2026-11-23T07:00:00Z") }),
      row({ id: "c", approvalStatus: "pending", createdAt: new Date("2026-11-23T08:00:00Z") }),
      row({
        id: "v",
        eventType: "voucher_change_adjustment",
        amount: 800,
        voucherFaceValue: 5000,
        voucherAppliedAmount: 4200,
        voucherChangeAmount: 800,
        originalPaymentMethod: null,
        actualRefundMethod: null,
        createdAt: new Date("2026-11-23T09:00:00Z"),
      }),
    ],
    { timeZone: TZ, labelOf: (m) => labels[m] ?? null, now: new Date("2026-11-23T10:00:00Z") },
  );
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.entries.map((e) => e.id), ["a", "b", "c", "v"]);
  const [a, b, c, v] = doc.entries;
  assert.equal(a.status, "voided");
  assert.equal(a.replacedBy, "b");
  // 登録した人・直したわけは注文に入れない（DB だけ）
  assert.equal("reason" in a, false);
  assert.equal("by" in a, false);
  assert.equal(b.replaces, "a");
  assert.equal(b.status, "active");
  assert.equal(b.fromLabel, "クレジット");
  assert.equal(b.toLabel, "現金");
  assert.equal(c.status, "pending_approval");
  assert.equal(v.type, "voucher");
  assert.deepEqual(v.voucher, { face: 5000, applied: 4200, change: 800 });
  assert.equal(v.amount, 800);
  assert.equal(v.fromMethod, null);
  assert.equal(b.locationGid, LOC);
  // 文字にして読み直しても同じ
  const parsed = parseOrderAdjustmentsDoc(JSON.stringify(doc));
  assert.ok(parsed.ok);
  if (parsed.ok) assert.deepEqual(parsed.doc.entries, doc.entries);
});

test("一行の要約: 無効は出さず、承認待ちは印を付ける", () => {
  const doc = buildOrderAdjustmentsDoc(
    [
      row({ id: "a", status: "voided" }),
      row({ id: "b", amount: 1000 }),
      row({
        id: "v",
        eventType: "voucher_change_adjustment",
        voucherFaceValue: 5000,
        voucherAppliedAmount: 4200,
        voucherChangeAmount: 800,
        countDate: "2026-11-03",
      }),
    ],
    { timeZone: TZ, labelOf: (m) => (m === "cash" ? "現金" : m === "shopify_payments" ? "クレジット" : null) },
  );
  assert.equal(
    buildOrderAdjustmentsSummary(doc),
    "11/23 返金方法変更 クレジット→現金 ¥1,000 ／ 11/3 商品券 額面¥5,000 お釣り¥800",
  );
});

test("読めない値: 空・JSON でない・行の形が違う", () => {
  assert.deepEqual(parseOrderAdjustmentsDoc(null), { ok: false, reason: "missing" });
  assert.deepEqual(parseOrderAdjustmentsDoc("{"), { ok: false, reason: "invalid_json" });
  assert.deepEqual(parseOrderAdjustmentsDoc('{"entries":[{"id":"x"}]}'), { ok: false, reason: "invalid_shape" });
  // 素の配列も読める
  const doc = buildOrderAdjustmentsDoc([row({ id: "a" })], { timeZone: TZ });
  assert.equal(parseOrderAdjustmentsDoc(JSON.stringify(doc.entries)).ok, true);
});

test("その日・その店の行だけ（無効は除く）", () => {
  const doc = buildOrderAdjustmentsDoc(
    [
      row({ id: "a" }),
      row({ id: "b", status: "voided" }),
      row({ id: "c", countDate: "2026-11-22" }),
      row({ id: "d", locationId: "gid://shopify/Location/2002" }),
      row({ id: "e", locationId: "1001" }),
    ],
    { timeZone: TZ },
  );
  assert.deepEqual(entriesForDayAndLocation(doc, "2026-11-23", LOC).map((e) => e.id), ["a", "e"]);
});

test("精算: 注文の値が DB と同じなら書き直さない。数えるのはアプリの記録", () => {
  const rows = [row({ id: "a" })];
  const doc = buildOrderAdjustmentsDoc(rows, { timeZone: TZ });
  const r = resolveSettlementAdjustments({
    date: "2026-11-23",
    locationGid: LOC,
    dbRows: rows,
    docs: new Map([["gid://shopify/Order/5001", JSON.stringify(doc)]]),
    docsFetched: true,
  });
  assert.equal(r.needsResync.length, 0);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].amount, 1200);
  assert.equal(r.events[0].actualRefundMethod, "cash");
});

test("精算: 違うときはアプリの記録で数え、注文を書き直す（T の決定。見直し P1-2 の場面）", () => {
  // 1) 「変更」1,000 → 600 のあと注文への書き込みが失敗（注文には前の行が active のまま）
  const changed = [row({ id: "b", amount: 600, replacesEventId: "a" })];
  const staleDoc = buildOrderAdjustmentsDoc([row({ id: "a", amount: 1000 })], { timeZone: TZ });
  // 2) 承認待ちの行を Shopify の画面で active・99,999 に書き換え
  const pending = [row({ id: "p", sourceOrderId: "gid://shopify/Order/5002", approvalStatus: "pending" })];
  const tamperedDoc = buildOrderAdjustmentsDoc(pending, { timeZone: TZ });
  tamperedDoc.entries[0].status = "active";
  tamperedDoc.entries[0].amount = 99999;
  // 3) Shopify 返金が pending の行を skipped に書き換え
  const refundPending = [row({ id: "q", sourceOrderId: "gid://shopify/Order/5003", shopifyRefundStatus: "pending" })];
  const skippedDoc = buildOrderAdjustmentsDoc(refundPending, { timeZone: TZ });
  skippedDoc.entries[0].shopifyRefund.status = "skipped";
  const r = resolveSettlementAdjustments({
    date: "2026-11-23",
    locationGid: LOC,
    dbRows: [...changed, ...pending, ...refundPending],
    docs: new Map([
      ["gid://shopify/Order/5001", JSON.stringify(staleDoc)],
      ["gid://shopify/Order/5002", JSON.stringify(tamperedDoc)],
      ["gid://shopify/Order/5003", JSON.stringify(skippedDoc)],
    ]),
    docsFetched: true,
  });
  assert.deepEqual(
    r.events.map((e) => [e.id, e.amount, e.approvalStatus, e.shopifyRefundStatus]),
    [
      ["b", 600, "none", "skipped"],
      ["p", 1200, "pending", "skipped"],
      ["q", 1200, "none", "pending"],
    ],
  );
  assert.deepEqual(
    r.needsResync.map((w) => [w.sourceOrderId, w.reason]),
    [
      ["gid://shopify/Order/5001", "metafield_differs"],
      ["gid://shopify/Order/5002", "metafield_differs"],
      ["gid://shopify/Order/5003", "metafield_differs"],
    ],
  );
});

test("精算: 2 件目を足したのに古い値が残った・「今日の分にする」が書けていない、も DB で数えて書き直す", () => {
  const rows = [row({ id: "a", amount: 1000 }), row({ id: "c", amount: 300 })];
  const oldDoc = buildOrderAdjustmentsDoc([rows[0]], { timeZone: TZ });
  const r = resolveSettlementAdjustments({
    date: "2026-11-23",
    locationGid: LOC,
    dbRows: rows,
    docs: new Map([["gid://shopify/Order/5001", JSON.stringify(oldDoc)]]),
    docsFetched: true,
  });
  assert.deepEqual(r.events.map((e) => e.amount), [1000, 300]);
  assert.deepEqual(r.needsResync.map((w) => w.reason), ["metafield_differs"]);
  // 今日（11/25）に移した行。注文には元の日（11/23）のまま
  const moved = [row({ id: "m", countDate: "2026-11-25" })];
  const notMoved = buildOrderAdjustmentsDoc([row({ id: "m", countDate: "2026-11-23" })], { timeZone: TZ });
  const today = resolveSettlementAdjustments({
    date: "2026-11-25",
    locationGid: LOC,
    dbRows: moved,
    docs: new Map([["gid://shopify/Order/5001", JSON.stringify(notMoved)]]),
    docsFetched: true,
  });
  assert.equal(today.events.length, 1);
  assert.deepEqual(today.needsResync.map((w) => w.reason), ["metafield_differs"]);
});

test("精算: 注文に値が無い・読めないときも書き直す。読まなかった（設定オフ・読めない）ときは比べない", () => {
  const rows = [row({ id: "a" })];
  const missing = resolveSettlementAdjustments({
    date: "2026-11-23",
    locationGid: LOC,
    dbRows: rows,
    docs: new Map(),
    docsFetched: true,
  });
  assert.equal(missing.events[0].amount, 1200);
  assert.deepEqual(missing.needsResync.map((w) => w.reason), ["metafield_missing"]);
  const broken = resolveSettlementAdjustments({
    date: "2026-11-23",
    locationGid: LOC,
    dbRows: rows,
    docs: new Map([["gid://shopify/Order/5001", "not json"]]),
    docsFetched: true,
  });
  assert.deepEqual(broken.needsResync.map((w) => w.reason), ["metafield_invalid"]);
  const notFetched = resolveSettlementAdjustments({
    date: "2026-11-23",
    locationGid: LOC,
    dbRows: rows,
    docs: new Map(),
    docsFetched: false,
  });
  assert.equal(notFetched.events.length, 1);
  assert.equal(notFetched.needsResync.length, 0);
});

test("精算: 注文に書く設定にする前の登録（書いたことが無い注文）は比べず、書き直さない（見直し P2-A）", () => {
  const legacy = [row({ id: "old", metafieldSyncedAt: null, metafieldSyncError: null })];
  const failed = [row({ id: "f", sourceOrderId: "gid://shopify/Order/5002", metafieldSyncedAt: null, metafieldSyncError: "429" })];
  const r = resolveSettlementAdjustments({
    date: "2026-11-23",
    locationGid: LOC,
    dbRows: [...legacy, ...failed],
    docs: new Map(),
    docsFetched: true,
  });
  assert.deepEqual(r.events.map((e) => e.id), ["old", "f"]);
  assert.equal(r.notWrittenOrderCount, 1);
  // 書けなかった注文は、設定にしてから書こうとした注文なので書き直す
  assert.deepEqual(r.needsResync.map((w) => [w.sourceOrderId, w.reason]), [["gid://shopify/Order/5002", "metafield_missing"]]);
});

test("精算: 少し前に精算で書き直した注文がまた違うときは、書き直さずに知らせる", () => {
  const rows = [row({ id: "a", amount: 1000 })];
  const tampered = buildOrderAdjustmentsDoc(rows, { timeZone: TZ });
  tampered.entries[0].amount = 1;
  const r = resolveSettlementAdjustments({
    date: "2026-11-23",
    locationGid: LOC,
    dbRows: rows,
    docs: new Map([["gid://shopify/Order/5001", JSON.stringify(tampered)]]),
    docsFetched: true,
    recentlyRewritten: new Set(["gid://shopify/Order/5001"]),
  });
  assert.equal(r.needsResync.length, 0);
  assert.deepEqual(r.warnings.map((w) => w.reason), ["metafield_differs_again"]);
  assert.equal(r.events[0].amount, 1000);
});

test("商品券で払った額: 商品券の売上を足し、商品券の返金を引く。失敗した取引と他の支払方法は数えない", () => {
  assert.deepEqual(
    voucherAppliedFromTransactions([
      { kind: "SALE", status: "SUCCESS", gateway: "商品券釣有り", amount: "4200" },
      { kind: "SALE", status: "SUCCESS", gateway: "cash", amount: "1000" },
      { kind: "SALE", status: "FAILURE", gateway: "商品券釣有り", amount: "999" },
      { kind: "REFUND", status: "SUCCESS", gateway: "商品券釣有り", amount: "200" },
    ]),
    { applied: 4000, found: true },
  );
  // 商品券の取引が無い（言葉を変えた店・マスタで分けた店）: found=false で、0 円のお釣り＝額面にしない
  assert.deepEqual(
    voucherAppliedFromTransactions([{ kind: "SALE", status: "SUCCESS", gateway: "facility_points", amount: "3000" }]),
    { applied: 0, found: false },
  );
  // マスタで商品券にした支払方法も見る
  assert.deepEqual(
    voucherAppliedFromTransactions(
      [{ kind: "SALE", status: "SUCCESS", gateway: "facility_points", amount: "3000" }],
      (gw) => gw === "facility_points",
    ),
    { applied: 3000, found: true },
  );
  assert.equal(voucherChangeOf(5000, 4200), 800);
  assert.equal(voucherChangeOf(3000, 4200), 0);
});

const NOW = new Date("2026-11-25T03:00:00Z");

test("変更: 元の日のまま（初めの値）で新しい行を作り、Shopify の返金はしない（記録のみ）", () => {
  const plan = planAdjustmentEdit(
    row({ id: "a", countDate: "2026-11-23" }),
    { amount: 1000, actualRefundMethod: "facility_points", reason: "手段の入れ間違い", by: "佐藤" },
    { timeZone: TZ, now: NOW, approvalStatusForNew: "none" },
  );
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(plan.create.countDate, "2026-11-23");
  assert.equal(plan.create.amount, 1000);
  assert.equal(plan.create.actualRefundMethod, "facility_points");
  assert.equal(plan.create.originalPaymentMethod, "shopify_payments");
  assert.equal(plan.create.replacesEventId, "a");
  assert.equal(plan.create.shopifyRefundStatus, "skipped");
  assert.equal(plan.create.createdBy, "佐藤");
  assert.equal(plan.warning, null);
});

test("変更: 今日にするを選ぶと数える日は今日", () => {
  const plan = planAdjustmentEdit(
    row({ id: "a" }),
    { reason: "日を直す", dateMode: "today" },
    { timeZone: TZ, now: NOW, approvalStatusForNew: "none" },
  );
  assert.ok(plan.ok && plan.create.countDate === "2026-11-25");
});

test("変更: Shopify で返金済みの行は返金の記録を引き継ぐ（二重に数えない）。金額を変えたら警告", () => {
  const old = row({ id: "a", shopifyRefundStatus: "success", shopifyRefundId: "gid://shopify/Refund/9" });
  const same = planAdjustmentEdit(old, { actualRefundMethod: "cash", reason: "手段" }, { timeZone: TZ, now: NOW, approvalStatusForNew: "none" });
  assert.ok(same.ok);
  if (same.ok) {
    assert.equal(same.create.shopifyRefundStatus, "success");
    assert.equal(same.create.shopifyRefundId, "gid://shopify/Refund/9");
    assert.match(String(same.warning), /Shopify の返金はそのまま/);
  }
  const changed = planAdjustmentEdit(old, { amount: 1000, reason: "金額" }, { timeZone: TZ, now: NOW, approvalStatusForNew: "none" });
  assert.ok(changed.ok && /金額は変わりません/.test(String(changed.warning)));
});

test("変更: わけが無い・無効の行・返金の結果が分からない行は直せない", () => {
  const ctx = { timeZone: TZ, now: NOW, approvalStatusForNew: "none" };
  const noReason = planAdjustmentEdit(row({ id: "a" }), { amount: 1 }, ctx);
  assert.ok(!noReason.ok && noReason.code === "EDIT_REASON_REQUIRED");
  const voided = planAdjustmentEdit(row({ id: "a", status: "voided" }), { reason: "x" }, ctx);
  assert.ok(!voided.ok && voided.code === "NOT_ACTIVE");
  const pending = planAdjustmentEdit(row({ id: "a", shopifyRefundStatus: "pending" }), { reason: "x" }, ctx);
  assert.ok(!pending.ok && pending.code === "SHOPIFY_REFUND_PENDING");
  const zero = planAdjustmentEdit(row({ id: "a" }), { amount: 0, reason: "x" }, ctx);
  assert.ok(!zero.ok && zero.code === "INVALID_AMOUNT");
});

test("変更: 商品券は額面を直すとお釣りを出し直す（使った額は前のまま）", () => {
  const plan = planAdjustmentEdit(
    row({
      id: "v",
      eventType: "voucher_change_adjustment",
      amount: 800,
      voucherFaceValue: 5000,
      voucherAppliedAmount: 4200,
      voucherChangeAmount: 800,
      originalPaymentMethod: null,
      actualRefundMethod: null,
    }),
    { voucherFaceValue: 10000, reason: "額面の入れ間違い" },
    { timeZone: TZ, now: NOW, approvalStatusForNew: "none" },
  );
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.equal(plan.create.voucherFaceValue, 10000);
    assert.equal(plan.create.voucherAppliedAmount, 4200);
    assert.equal(plan.create.voucherChangeAmount, 5800);
    assert.equal(plan.create.amount, 5800);
  }
});

test("注文ページの表示: 注文の値とアプリの記録が同じか（表示名の違いは見ない）", () => {
  const rows = [row({ id: "a" })];
  const built = buildOrderAdjustmentsDoc(rows, { timeZone: TZ, labelOf: () => "現金" });
  const sameButLabel = JSON.stringify({ ...built, entries: built.entries.map((e) => ({ ...e, toLabel: "げんきん" })) });
  const changed = JSON.stringify({ ...built, entries: built.entries.map((e) => ({ ...e, amount: 999 })) });
  assert.equal(orderMetafieldStateOf({ rowCount: 1, fetched: true, currentValue: sameButLabel, built }), "same");
  assert.equal(orderMetafieldStateOf({ rowCount: 1, fetched: true, currentValue: changed, built }), "differs");
  assert.equal(orderMetafieldStateOf({ rowCount: 1, fetched: true, currentValue: null, built }), "missing");
  assert.equal(orderMetafieldStateOf({ rowCount: 1, fetched: true, currentValue: "{x", built }), "invalid");
  assert.equal(orderMetafieldStateOf({ rowCount: 1, fetched: false, currentValue: null, built }), "unreadable");
  const empty = buildOrderAdjustmentsDoc([], { timeZone: TZ, labelOf: () => null });
  assert.equal(orderMetafieldStateOf({ rowCount: 0, fetched: true, currentValue: null, built: empty }), "none");
});

test("変更: 純正の返金の付け替えは金額と数える日を変えられない（手段だけ直す）。返金の記録と印は引き継ぐ", () => {
  const old = row({
    id: "n",
    amount: 3000,
    countDate: "2026-11-22",
    shopifyRefundStatus: "success",
    shopifyRefundId: "gid://shopify/Refund/7",
    refundSource: "native",
  });
  const ctx = { timeZone: TZ, now: NOW, approvalStatusForNew: "none" };
  const changed = planAdjustmentEdit(old, { amount: 2000, reason: "額" }, ctx);
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.code, "NATIVE_REFUND_AMOUNT_FIXED");
  const method = planAdjustmentEdit(old, { actualRefundMethod: "cash", dateMode: "today", reason: "手段" }, ctx);
  assert.ok(method.ok);
  if (method.ok) {
    assert.equal(method.create.amount, 3000);
    assert.equal(method.create.countDate, "2026-11-22");
    assert.equal(method.create.refundSource, "native");
    assert.equal(method.create.shopifyRefundStatus, "success");
    assert.equal(method.create.shopifyRefundId, "gid://shopify/Refund/7");
    assert.match(String(method.warning), /純正の返金はそのまま/);
  }
});
