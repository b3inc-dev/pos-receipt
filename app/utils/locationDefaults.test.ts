import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_DEFAULTS,
  differingKeys,
  featureSummary,
  inferDefaults,
  locationGidFromNumeric,
  locationNumericId,
  newLocationIds,
  planBulkChange,
  planDefaultsChange,
  readBulkForm,
  readDefaultsForm,
  readStoredDefaults,
  resetToDefaults,
  type LocationValues,
} from "./locationDefaults";

const loc = (id: string, over: Partial<LocationValues> = {}): LocationValues => ({ id, ...SCHEMA_DEFAULTS, ...over });

test("仮の決まりは、今いちばん多い値（同数は DB の初期値）", () => {
  const locations = [loc("a", { specialRefundEnabled: false }), loc("b", { specialRefundEnabled: false }), loc("d", { budgetTargetEnabled: true })];
  const d = inferDefaults(locations);
  assert.equal(d.specialRefundEnabled, false);
  assert.equal(d.settlementEnabled, true);
  assert.equal(d.budgetTargetEnabled, false);
  // 同数
  assert.equal(inferDefaults([loc("a", { receiptEnabled: false }), loc("b")]).receiptEnabled, true);
  assert.deepEqual(inferDefaults([]), SCHEMA_DEFAULTS);
});

test("決まりを変えると、全店と同じの店だけ書き換え、店ごとの変更は残す", () => {
  const old = { ...SCHEMA_DEFAULTS };
  const next = { ...SCHEMA_DEFAULTS, specialRefundEnabled: false, budgetTargetEnabled: true };
  const locations = [loc("same"), loc("custom", { specialRefundEnabled: false }), loc("custom2", { budgetTargetEnabled: true, receiptEnabled: false })];
  const plan = planDefaultsChange(locations, old, next);
  assert.deepEqual(plan.updates, [
    { id: "same", data: { specialRefundEnabled: false, budgetTargetEnabled: true } },
    { id: "custom", data: { budgetTargetEnabled: true } },
    { id: "custom2", data: { specialRefundEnabled: false } },
  ]);
  assert.equal(plan.customCount, 2);
  assert.equal(plan.followingCount, 1);
});

test("決まりが同じなら何も書かない・使えない項目は変えない", () => {
  const locations = [loc("a"), loc("b")];
  assert.deepEqual(planDefaultsChange(locations, SCHEMA_DEFAULTS, SCHEMA_DEFAULTS).updates, []);
  const next = { ...SCHEMA_DEFAULTS, salesSummaryEnabled: true };
  assert.deepEqual(planDefaultsChange(locations, SCHEMA_DEFAULTS, next, ["salesSummaryEnabled"]).updates, []);
});

test("まとめて変更は選んだ店だけ、今と違う項目だけ", () => {
  const locations = [loc("a"), loc("b", { specialRefundEnabled: false }), loc("c")];
  const updates = planBulkChange(locations, ["a", "b"], { specialRefundEnabled: false, receiptEnabled: true });
  assert.deepEqual(updates, [{ id: "a", data: { specialRefundEnabled: false } }]);
  assert.deepEqual(planBulkChange(locations, ["a"], { salesSummaryEnabled: true }, ["salesSummaryEnabled"]), []);
});

test("全店と同じに戻すのは、違う項目だけ", () => {
  const d = { ...SCHEMA_DEFAULTS };
  const l = loc("a", { receiptEnabled: false, budgetTargetEnabled: true });
  assert.deepEqual(differingKeys(l, d), ["receiptEnabled", "budgetTargetEnabled"]);
  assert.deepEqual(resetToDefaults(l, d), { receiptEnabled: true, budgetTargetEnabled: false });
  assert.deepEqual(resetToDefaults(l, d, ["budgetTargetEnabled"]), { receiptEnabled: true });
});

test("あとから足された店は、決まりを当てた店の一覧に無い店（決まりが無ければ無し）", () => {
  assert.deepEqual(newLocationIds(["x", "y"], null), []);
  const stored = readStoredDefaults({ defaults: { receiptEnabled: false }, appliedLocationIds: ["x"], savedAt: "t" });
  assert.ok(stored);
  assert.equal(stored.defaults.receiptEnabled, false);
  assert.equal(stored.defaults.settlementEnabled, true);
  assert.deepEqual(newLocationIds(["x", "y"], stored), ["y"]);
  assert.equal(readStoredDefaults(null), null);
  assert.equal(readStoredDefaults({ appliedLocationIds: [] }), null);
});

test("フォームの読み方と要約", () => {
  const form = new Map<string, string>([["settlementEnabled", "on"], ["receiptEnabled", "on"]]);
  const d = readDefaultsForm(form, { ...SCHEMA_DEFAULTS, salesSummaryEnabled: true }, ["salesSummaryEnabled"]);
  assert.equal(d.settlementEnabled, true);
  assert.equal(d.specialRefundEnabled, false);
  assert.equal(d.salesSummaryEnabled, true, "使えない項目は今の値のまま");
  assert.equal(featureSummary(d, "features"), "精算・領収書");
  assert.equal(featureSummary({ ...d, settlementEnabled: false, receiptEnabled: false }, "features"), "なし");
  const bulk = readBulkForm(new Map([["settlementEnabled", "off"], ["receiptEnabled", ""], ["budgetTargetEnabled", "on"]]));
  assert.deepEqual(bulk, { settlementEnabled: false, budgetTargetEnabled: true });
});

test("ロケーションの番号と GID", () => {
  assert.equal(locationNumericId("gid://shopify/Location/123"), "123");
  assert.equal(locationGidFromNumeric("123"), "gid://shopify/Location/123");
  assert.equal(locationGidFromNumeric("../x"), null);
});
