import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encodeReceiptPrintSnapshot,
  parseReceiptPrintSnapshot,
  redactReceiptPrintSnapshot,
  renderReceiptHtmlByPaperWidth,
  REDACTED_RECIPIENT_NAME,
} from "./receiptPrintSnapshot.server";
import { redactReceiptIssuesForOrders, type ReceiptRedactDb } from "./receiptRedact.server";

const row = {
  recipientName: "山田太郎",
  proviso: "お品代として",
  amount: "12345",
  currency: "JPY",
  createdAt: new Date("2026-11-20T03:00:00Z"),
  orderName: "#1001",
};
const templateData = { companyName: "発行時会社", address: "発行時住所", phone: "00-0000-0000", showOrderNumber: true, showDate: true };

function issuedSnapshot() {
  return encodeReceiptPrintSnapshot({
    locationName: "発行時店舗",
    templateData,
    renderedHtmlByPaperWidth: renderReceiptHtmlByPaperWidth(row, "発行時店舗", templateData),
  });
}

describe("お客様の削除の依頼で領収書の宛名を消す", () => {
  it("発行時の紙面には宛名が入っている（前提）", () => {
    const snap = parseReceiptPrintSnapshot(issuedSnapshot());
    assert.ok(snap);
    assert.match(snap.renderedHtmlByPaperWidth[58], /山田太郎/);
    assert.match(snap.renderedHtmlByPaperWidth[80], /山田太郎/);
  });

  it("削除のあとの紙面（刷り直しで出るもの）に宛名が出ない。会社・店・金額・注文番号は発行時のまま", () => {
    const redacted = parseReceiptPrintSnapshot(redactReceiptPrintSnapshot(issuedSnapshot(), row));
    assert.ok(redacted, "読める紙面のまま残す");
    for (const width of [58, 80] as const) {
      const html = redacted.renderedHtmlByPaperWidth[width];
      assert.doesNotMatch(html, /山田太郎/);
      assert.doesNotMatch(html, /redacted/);
      assert.match(html, /発行時会社/);
      assert.match(html, /発行時店舗/);
      assert.match(html, /12,345/);
      assert.match(html, /#1001/);
    }
  });

  it("読めない紙面・無い紙面は残さない（null）", () => {
    assert.equal(redactReceiptPrintSnapshot("{broken", row), null);
    assert.equal(redactReceiptPrintSnapshot(null, row), null);
  });

  it("その注文の全部の発行（再発行も）で、宛名の列と紙面の両方を書き換える", async () => {
    const updates: Array<{ id: string; recipientName: string; printSnapshotJson: string | null }> = [];
    let findWhere: unknown = null;
    const db = {
      receiptIssue: {
        async findMany(args: { where: unknown }) {
          findWhere = args.where;
          return [
            { id: "r1", ...row, printSnapshotJson: issuedSnapshot() },
            { id: "r2", ...row, printSnapshotJson: null },
          ];
        },
        async update(args: { where: { id: string }; data: { recipientName: string; printSnapshotJson: string | null } }) {
          updates.push({ id: args.where.id, ...args.data });
          return {};
        },
      },
    } as unknown as ReceiptRedactDb;
    const n = await redactReceiptIssuesForOrders(db, "shop1", ["1001", "gid://shopify/Order/1001"]);
    assert.equal(n, 2);
    assert.deepEqual(findWhere, { shopId: "shop1", orderId: { in: ["1001", "gid://shopify/Order/1001"] } });
    assert.deepEqual(updates.map((u) => [u.id, u.recipientName]), [["r1", REDACTED_RECIPIENT_NAME], ["r2", REDACTED_RECIPIENT_NAME]]);
    assert.ok(updates[0].printSnapshotJson);
    assert.doesNotMatch(updates[0].printSnapshotJson, /山田太郎/);
    assert.equal(updates[1].printSnapshotJson, null);
  });

  it("注文が無ければ何もしない", async () => {
    const db = { receiptIssue: { findMany: async () => { throw new Error("呼ばない"); }, update: async () => { throw new Error("呼ばない"); } } } as unknown as ReceiptRedactDb;
    assert.equal(await redactReceiptIssuesForOrders(db, "shop1", []), 0);
  });
});
