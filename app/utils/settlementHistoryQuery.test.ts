import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSettlementHistoryWhere,
  dateRangeWarning,
  formatExecutedAt,
  formatYen,
  isInspectionPeriod,
  normalizeHistoryDate,
  normalizeHistoryKind,
  normalizeHistoryPage,
  settlementLocationLabel,
} from "./settlementHistoryQuery";

test("日付・種別・ページは比較に使える値だけ残す", () => {
  assert.equal(normalizeHistoryDate("2026-10-08"), "2026-10-08");
  assert.equal(normalizeHistoryDate("2026/10/08"), "");
  assert.equal(normalizeHistoryKind("inspection"), "inspection");
  assert.equal(normalizeHistoryKind("other"), "all");
  assert.equal(normalizeHistoryPage("2"), 2);
  assert.equal(normalizeHistoryPage("0"), 1);
  assert.equal(normalizeHistoryPage("nope"), 1);
});

test("点検は periodLabel の接頭辞で判定し、未設定は精算", () => {
  assert.equal(isInspectionPeriod("点検_2026-10-08"), true);
  assert.equal(isInspectionPeriod("2026-10-08"), false);
  assert.equal(isInspectionPeriod(null), false);
});

test("ロケーションは表示名を優先し、未登録は金額と紛れる ID を出さない", () => {
  assert.deepEqual(
    settlementLocationLabel({ name: "渋谷店", displayName: "渋谷" }, "gid://shopify/Location/1"),
    { label: "渋谷", title: "渋谷（渋谷店）" },
  );
  assert.equal(
    settlementLocationLabel(undefined, "gid://shopify/Location/99").label,
    "未登録のロケーション",
  );
});

test("金額は桁を揃えて、実行日時は指定タイムゾーンで揃える", () => {
  assert.equal(formatYen("125000"), "¥125,000");
  assert.equal(formatYen("nope"), "—");
  assert.equal(
    formatExecutedAt("2026-10-08T09:05:00.000Z", "Asia/Tokyo"),
    "2026/10/08 18:05",
  );
  assert.equal(
    formatExecutedAt("2026-10-08T09:05:00.000Z", "Not/AZone"),
    "2026/10/08 18:05",
  );
});

test("開始日が終了日より後なら案内する", () => {
  assert.equal(dateRangeWarning("2026-10-10", "2026-10-01")?.includes("入れ替え"), true);
  assert.equal(dateRangeWarning("2026-10-01", "2026-10-10"), null);
});

test("絞り込みは店舗を必ず含み、点検と精算を分ける", () => {
  const inspection = buildSettlementHistoryWhere({
    shopId: "shop-1",
    dateFrom: "2026-10-01",
    dateTo: "",
    locationId: "gid://shopify/Location/1",
    kind: "inspection",
  });
  assert.equal(inspection.shopId, "shop-1");
  assert.deepEqual(inspection.targetDate, { gte: "2026-10-01" });
  assert.equal(inspection.locationId, "gid://shopify/Location/1");
  assert.deepEqual(inspection.periodLabel, { startsWith: "点検_" });

  const settlement = buildSettlementHistoryWhere({
    shopId: "shop-1",
    dateFrom: "",
    dateTo: "",
    locationId: "",
    kind: "settlement",
  });
  assert.equal(settlement.locationId, undefined);
  assert.ok(Array.isArray(settlement.OR));
  assert.equal(settlement.OR?.[0]?.periodLabel, null);
});
