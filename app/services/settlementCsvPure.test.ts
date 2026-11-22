import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSettlementCsv,
  countDaysInclusive,
  escapeCsvCell,
  formatDateTimeInTz,
  isValidYmd,
  parsePaymentSections,
  selectLatestSettlements,
  SETTLEMENT_CSV_COLUMNS,
  type SettlementCsvSourceRow,
} from "./settlementCsvPure.server";

function row(over: Partial<SettlementCsvSourceRow> & { id: string }): SettlementCsvSourceRow {
  return {
    locationId: "gid://shopify/Location/100",
    targetDate: "2026-11-20",
    periodLabel: "2026-11-20",
    currency: "JPY",
    total: "9000",
    netSales: "8182",
    tax: "818",
    discounts: "500",
    vipPointsUsed: "200",
    refundTotal: "1000",
    orderCount: 5,
    refundCount: 1,
    voucherChangeAmount: "0",
    paymentSectionsJson: JSON.stringify([
      { gateway: "cash", label: "現金", net: 6000, refund: 1000, txCount: 3, refundCount: 1 },
      { gateway: "shopify_payments", label: "クレジット", net: 4000, refund: 0, txCount: 2, refundCount: 0 },
    ]),
    status: "completed",
    createdAt: new Date("2026-11-20T12:00:00Z"),
    ...over,
  };
}

const baseOpts = {
  dateFrom: "2026-11-01",
  dateTo: "2026-11-30",
  timezone: "Asia/Tokyo",
  locationNames: new Map([
    ["gid://shopify/Location/100", "渋谷店"],
    ["gid://shopify/Location/200", "新宿店"],
  ]),
  locationFilterLabel: "全店舗",
  generatedAt: new Date("2026-11-22T15:00:00Z"),
};

/** BOM と「#」行を除いた表の部分（ヘッダー行 + データ行） */
function table(csv: string): string[][] {
  assert.ok(csv.startsWith("﻿"), "BOM 付き");
  return csv
    .slice(1)
    .split("\r\n")
    .filter((l) => l && !l.startsWith("#") && !l.startsWith('"#'))
    .map((l) => l.split(","));
}

describe("settlementCsvPure", () => {
  it("validates dates and day counts", () => {
    assert.equal(isValidYmd("2026-02-28"), true);
    assert.equal(isValidYmd("2026-02-30"), false);
    assert.equal(isValidYmd("2026/02/01"), false);
    assert.equal(countDaysInclusive("2026-11-01", "2026-11-30"), 30);
    assert.equal(countDaysInclusive("2026-11-02", "2026-11-01"), 0);
  });

  it("escapes cells and neutralizes formula-like text", () => {
    assert.equal(escapeCsvCell('a,"b"'), '"a,""b"""');
    assert.equal(escapeCsvCell("=SUM(A1)", { text: true }), "'=SUM(A1)");
    assert.equal(escapeCsvCell("-100"), "-100", "numbers are not touched");
  });

  it("parses payment sections defensively", () => {
    assert.deepEqual(parsePaymentSections("not json"), []);
    assert.deepEqual(parsePaymentSections("{}"), []);
    // #22 のあとの新しい形（印字のスナップショットつき）も読む
    const envelope = JSON.stringify({
      format: "settlement_print_v1",
      snapshot: { formVersion: "settlement-receipt-v1", locationName: "梅田", title: "精算", isInspection: false },
      sections: [{ gateway: "cash", label: "現金", net: 1200, refund: 200, txCount: 3, refundCount: 1 }],
    });
    assert.deepEqual(parsePaymentSections(envelope), [
      { gateway: "cash", label: "現金", net: 1200, refund: 200, txCount: 3, refundCount: 1 },
    ]);
    assert.equal(parsePaymentSections('[{"gateway":"cash","net":"10"}]')[0].label, "cash");
  });

  it("selects the latest non-inspection settlement per store and day", () => {
    const rows = [
      row({ id: "old", createdAt: new Date("2026-11-20T10:00:00Z") }),
      row({ id: "new", locationId: "100", createdAt: new Date("2026-11-20T13:00:00Z") }),
      row({ id: "insp", periodLabel: "点検_2026-11-20", createdAt: new Date("2026-11-20T14:00:00Z") }),
      row({ id: "draft", status: "draft", createdAt: new Date("2026-11-20T15:00:00Z") }),
      row({ id: "other", locationId: "gid://shopify/Location/200" }),
    ];
    const r = selectLatestSettlements(rows);
    assert.deepEqual(r.selected.map((s) => s.id).sort(), ["new", "other"]);
    assert.equal(r.skippedInspectionCount, 1);
    assert.equal(r.skippedStatusCount, 1);
    assert.equal(r.skippedSupersededCount, 1);
  });

  it("writes one row per payment method plus a total row, from saved values only", () => {
    const { csv, settlementCount, rowCount } = buildSettlementCsv([row({ id: "s1" })], baseOpts);
    assert.equal(settlementCount, 1);
    assert.equal(rowCount, 3);
    const t = table(csv);
    assert.deepEqual(t[0], [...SETTLEMENT_CSV_COLUMNS]);
    const col = (name: (typeof SETTLEMENT_CSV_COLUMNS)[number]) => SETTLEMENT_CSV_COLUMNS.indexOf(name);

    const [cash, credit, total] = t.slice(1);
    assert.equal(cash[col("区分")], "支払方法");
    assert.equal(cash[col("ロケーションID")], "100");
    assert.equal(cash[col("ロケーション名")], "渋谷店");
    assert.equal(cash[col("支払方法")], "現金");
    assert.equal(cash[col("売上")], "6000");
    assert.equal(cash[col("返金")], "1000");
    assert.equal(cash[col("差引")], "5000");
    assert.equal(credit[col("差引")], "4000");

    assert.equal(total[col("区分")], "精算合計");
    assert.equal(total[col("売上")], "10000");
    assert.equal(total[col("返金")], "1000");
    assert.equal(total[col("差引")], "9000", "saved total, not recomputed");
    assert.equal(total[col("税抜売上")], "8182");
    assert.equal(total[col("消費税")], "818");
    assert.equal(total[col("割引")], "500");
    assert.equal(total[col("ポイント利用")], "200");
    assert.equal(total[col("通貨")], "JPY");
    assert.equal(total[col("精算日時")], "2026-11-20 21:00:00", "shown in the shop timezone");

    // 支払方法の差引の合計と精算合計の差引が一致する（保存時の整合）
    assert.equal(Number(cash[col("差引")]) + Number(credit[col("差引")]), Number(total[col("差引")]));
  });

  it("states range, timezone, currency and exclusions in the header notes", () => {
    const { csv } = buildSettlementCsv(
      [row({ id: "s1" }), row({ id: "i1", periodLabel: "点検_2026-11-20" })],
      baseOpts,
    );
    const notes = csv.slice(1).split("\r\n").filter((l) => l.startsWith("#") || l.startsWith('"#'));
    const text = notes.join("\n");
    assert.match(text, /対象期間: 2026-11-01 〜 2026-11-30/);
    assert.match(text, /タイムゾーン: Asia\/Tokyo/);
    assert.match(text, /通貨: JPY/);
    assert.match(text, /店舗: 全店舗/);
    assert.match(text, /精算 1 件（点検 1 件/);
    assert.match(text, /出力日時: 2026-11-23 00:00:00/);
  });

  it("sorts by date then store order and handles empty results", () => {
    const { csv } = buildSettlementCsv(
      [
        row({ id: "b", targetDate: "2026-11-21", periodLabel: "2026-11-21" }),
        row({ id: "a", locationId: "gid://shopify/Location/200" }),
        row({ id: "c", paymentSectionsJson: "[]" }),
      ],
      {
        ...baseOpts,
        locationSortOrder: new Map([
          ["gid://shopify/Location/200", 1],
          ["gid://shopify/Location/100", 2],
        ]),
      },
    );
    const ids = table(csv)
      .slice(1)
      .map((r) => `${r[0]}:${r[SETTLEMENT_CSV_COLUMNS.indexOf("精算ID")]}`);
    assert.deepEqual([...new Set(ids)], ["2026-11-20:a", "2026-11-20:c", "2026-11-21:b"]);

    const empty = buildSettlementCsv([], baseOpts);
    assert.equal(empty.rowCount, 0);
    assert.equal(table(empty.csv).length, 1, "header only");
    assert.match(empty.csv, /通貨: （該当なし）/);
  });

  it("falls back to ISO when the timezone is invalid", () => {
    const d = new Date("2026-11-20T12:00:00Z");
    assert.equal(formatDateTimeInTz(d, "Not/AZone"), d.toISOString());
  });
});
