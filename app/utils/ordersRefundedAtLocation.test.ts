import assert from "node:assert/strict";
import { test } from "node:test";
import { pickOrdersRefundedAtLocation } from "./ordersRefundedAtLocation";

const S = "2026-11-23T15:00:00Z"; // 11/24 0:00 JST
const E = "2026-11-24T14:59:59Z";
const order = (id: string, retail: string, refundAt: string, refundLoc: string) => ({
  id,
  retailLocation: { id: `gid://shopify/Location/${retail}` },
  refunds: [{ createdAt: refundAt, transactions: { nodes: [{ kind: "REFUND", location: { id: `gid://shopify/Location/${refundLoc}` } }] } }],
});

test("ほかの店舗で売って、この店舗でその日に返品した注文だけを選ぶ", () => {
  const picked = pickOrdersRefundedAtLocation(
    [
      order("o1", "1", "2026-11-24T03:00:00Z", "2"), // 他店で販売・ここで返品 → 出す
      order("o2", "2", "2026-11-24T03:00:00Z", "2"), // ここで販売 → いつもの一覧
      order("o3", "1", "2026-11-24T03:00:00Z", "3"), // 別の店で返品 → 出さない
      order("o4", "1", "2026-11-23T03:00:00Z", "2"), // 前の日の返品 → 出さない
      order("o1", "1", "2026-11-24T03:00:00Z", "2"), // 同じ注文は 1 回
    ],
    "2",
    S,
    E,
  );
  assert.deepEqual(picked.map((o) => o.id), ["o1"]);
});

test("店舗が分からなければ何も選ばない", () => {
  assert.deepEqual(pickOrdersRefundedAtLocation([order("o1", "1", "2026-11-24T03:00:00Z", "2")], "", S, E), []);
});
