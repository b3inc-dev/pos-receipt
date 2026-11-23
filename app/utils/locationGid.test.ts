/**
 * ロケーション ID の正規化（app/utils/locationGid.ts）
 * 以前は各ルートに写されていた関数と同じ動きであることを確かめる。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractLocationNumericId,
  normalizeLocationGid,
  normalizeLocationGidOrRaw,
} from "./locationGid";
import * as refundPure from "../services/refundAggregationPure.server";

const GID = "gid://shopify/Location/123";

describe("normalizeLocationGid", () => {
  it("GID・数値・末尾が /数値 の値を GID にそろえる", () => {
    assert.equal(normalizeLocationGid(GID), GID);
    assert.equal(normalizeLocationGid("123"), GID);
    assert.equal(normalizeLocationGid("  123  "), GID);
    assert.equal(normalizeLocationGid("shopify/Location/123"), GID);
  });
  it("空・取り出せない値は null", () => {
    assert.equal(normalizeLocationGid(""), null);
    assert.equal(normalizeLocationGid("   "), null);
    assert.equal(normalizeLocationGid(null), null);
    assert.equal(normalizeLocationGid(undefined), null);
    assert.equal(normalizeLocationGid("abc"), null);
  });
});

describe("normalizeLocationGidOrRaw（api.settlements.create の以前の動き）", () => {
  it("GID・数値は GID、それ以外は trim した元の値", () => {
    assert.equal(normalizeLocationGidOrRaw(GID), GID);
    assert.equal(normalizeLocationGidOrRaw(" 123 "), GID);
    assert.equal(normalizeLocationGidOrRaw("shopify/Location/123"), "shopify/Location/123");
    assert.equal(normalizeLocationGidOrRaw("abc"), "abc");
    assert.equal(normalizeLocationGidOrRaw(""), "");
  });
});

describe("extractLocationNumericId", () => {
  it("数値の ID を返す", () => {
    assert.equal(extractLocationNumericId(GID), "123");
    assert.equal(extractLocationNumericId("123"), "123");
    assert.equal(extractLocationNumericId("x"), null);
  });
});

describe("refundAggregationPure からの再公開", () => {
  it("同じ関数を指す（既存の import 先が変わらない）", () => {
    assert.equal(refundPure.normalizeLocationGid, normalizeLocationGid);
    assert.equal(refundPure.extractLocationNumericId, extractLocationNumericId);
  });
});
