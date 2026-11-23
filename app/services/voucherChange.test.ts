/**
 * 商品券設定（voucher_settings）を精算の「商品券釣有り差額」に効かせる試験。
 * 自動判定と POS「商品券調整」が同じ注文にあるときの二重計上の防止を含む。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateGasStyleForOrders, type GasStyleOrder } from "./settlementAggregatePure.server";
import {
  compileVoucherNoteRegex,
  DEFAULT_VOUCHER_DETECTION_RULES,
  normalizeOrderKey,
  parseVoucherFaceFromNoteWithRules,
  resolveVoucherChange,
  resolveVoucherSettings,
  VOUCHER_SETTINGS_VERSION,
  voucherDetectionRulesFromSettings,
  voucherManualAdjustmentAllowed,
} from "./voucherChangePure.server";
import { DEFAULT_VOUCHER_SETTINGS, type VoucherSettings } from "../utils/appSettings.server";

const always = (_iso?: string) => true;
const money = (n: number) => ({ shopMoney: { amount: String(n), currencyCode: "JPY" } });

function order(id: string, total: number, txs: { gw: string; fg?: string; amt: number }[], note: string | null = null): GasStyleOrder {
  return {
    id,
    note,
    cancelledAt: null,
    totalPriceSet: money(total),
    totalTaxSet: { shopMoney: { amount: "0" } },
    lineItems: { nodes: [{ quantity: 1 }] },
    transactions: txs.map((t, i) => ({
      id: `${id}-t${i}`,
      createdAt: "2026-11-20T01:00:00Z",
      kind: "SALE",
      amountSet: money(t.amt),
      gateway: t.gw,
      formattedGateway: t.fg ?? null,
    })),
    refunds: [],
    retailLocation: { id: "gid://shopify/Location/100" },
  } as GasStyleOrder;
}

// 会計 1500 = 商品券釣有り 1000 + 現金 1000 預かり → お釣り 500
const giftWithChange = order("gid://shopify/Order/6001", 1500, [
  { gw: "gift_card", fg: "釣有り", amt: 1000 },
  { gw: "cash", amt: 1000 },
]);
// メモ「商品券 3000円」、会計 2000 を現金 2000 → 額面からのお釣り 3000 − 0 = 3000（現金超過は 0）
const noteOnly = order("gid://shopify/Order/6002", 2000, [{ gw: "cash", amt: 2000 }], "商品券 ３，０００円");

const S = (over: Partial<VoucherSettings> = {}): VoucherSettings => ({
  ...DEFAULT_VOUCHER_SETTINGS,
  ...over,
});

describe("自動判定（集計）", () => {
  it("初めの設定は今までどおり（現金超過とメモ額面）。注文ごとの内訳も返す", () => {
    const r = aggregateGasStyleForOrders([giftWithChange, noteOnly], always);
    assert.equal(r.voucherChangeObserved, 3500);
    assert.deepEqual(r.voucherChangeByOrder, {
      "gid://shopify/Order/6001": 500,
      "gid://shopify/Order/6002": 3000,
    });
  });

  it("自動判定オフなら差額を数えない（現金は会計に必要な分だけのまま）", () => {
    const rules = voucherDetectionRulesFromSettings(S({ voucherAutoDetectionEnabled: false }));
    const r = aggregateGasStyleForOrders([giftWithChange], always, undefined, undefined, rules);
    assert.equal(r.voucherChangeObserved, 0);
    assert.deepEqual(r.voucherChangeByOrder, {});
    assert.equal(r.pay["現金"].sale, 500);
  });

  it("メモから読むのをオフにすると、メモの額面だけ見ない", () => {
    const rules = voucherDetectionRulesFromSettings(S({ voucherNoteParseEnabled: false }));
    const r = aggregateGasStyleForOrders([giftWithChange, noteOnly], always, undefined, undefined, rules);
    assert.equal(r.voucherChangeObserved, 500);
  });

  it("商品券とみなす言葉と読取用正規表現を変えられる", () => {
    const o = order("7001", 2000, [{ gw: "cash", amt: 2000 }], "ギフト券額面=5000");
    const rules = voucherDetectionRulesFromSettings(
      S({ voucherDefaultLabel: "ギフト券", voucherNoteParseRegex: "額面=([0-9]+)" }),
    );
    assert.equal(aggregateGasStyleForOrders([o], always, undefined, undefined, rules).voucherChangeObserved, 5000);
    // 初めの言葉「商品券」では拾わない
    assert.equal(aggregateGasStyleForOrders([o], always).voucherChangeObserved, 0);
  });

  it("全角数字・読点を半角にして読む", () => {
    assert.equal(parseVoucherFaceFromNoteWithRules("商品券　２，０００円", DEFAULT_VOUCHER_DETECTION_RULES), 2000);
  });
});

describe("自動と手入力を合わせる（二重計上の防止）", () => {
  const auto = { "gid://shopify/Order/6001": 500, "gid://shopify/Order/6002": 3000 };
  const manualSame = { id: "e1", sourceOrderId: "6001", voucherChangeAmount: 500 };
  const manualOther = { id: "e2", sourceOrderId: "gid://shopify/Order/6003", voucherChangeAmount: 200 };

  it("手動優先（初め）: 同じ注文は手入力だけ数え、自動の分は外す", () => {
    const r = resolveVoucherChange({
      settings: S(),
      reflectManualFromSpecialRefundSettings: true,
      autoByOrder: auto,
      manualEvents: [manualSame, manualOther],
    });
    assert.equal(r.total, 3000 + 500 + 200);
    assert.deepEqual(r.skippedAutoOrderKeys, ["6001"]);
    assert.equal(r.appliedManual.length, 2);
  });

  it("自動優先: 同じ注文は自動だけ数え、手入力の分は外す", () => {
    const r = resolveVoucherChange({
      settings: S({ voucherAdjustmentPriority: "auto_first" }),
      reflectManualFromSpecialRefundSettings: true,
      autoByOrder: auto,
      manualEvents: [manualSame, manualOther],
    });
    assert.equal(r.total, 500 + 3000 + 200);
    assert.deepEqual(r.skippedManualOrderKeys, ["6001"]);
    assert.deepEqual(r.appliedManual.map((e) => e.id), ["e2"]);
  });

  it("手入力の額が自動と違っても、片方だけ（手動優先なら手入力の額）", () => {
    const r = resolveVoucherChange({
      settings: S(),
      reflectManualFromSpecialRefundSettings: true,
      autoByOrder: { "6001": 500 },
      manualEvents: [{ sourceOrderId: "6001", voucherChangeAmount: 450 }],
    });
    assert.equal(r.total, 450);
  });

  it("手動調整オフ・特殊返金設定の反映オフなら手入力を数えない（自動は数える）", () => {
    for (const [settings, reflect] of [
      [S({ voucherManualAdjustmentEnabled: false }), true],
      [S(), false],
    ] as const) {
      const r = resolveVoucherChange({
        settings,
        reflectManualFromSpecialRefundSettings: reflect,
        autoByOrder: auto,
        manualEvents: [manualSame, manualOther],
      });
      assert.equal(r.total, 3500);
      assert.equal(r.appliedManual.length, 0);
    }
  });

  it("機能オフ・精算に反映オフなら 0", () => {
    for (const settings of [S({ voucherFeatureEnabled: false }), S({ reflectVoucherChangeInSettlement: false })]) {
      const r = resolveVoucherChange({
        settings,
        reflectManualFromSpecialRefundSettings: true,
        autoByOrder: auto,
        manualEvents: [manualSame],
      });
      assert.equal(r.total, 0);
    }
  });

  it("POS の登録を受け付けるのは機能・手動調整の両方がオンのときだけ", () => {
    assert.equal(voucherManualAdjustmentAllowed(S()), true);
    assert.equal(voucherManualAdjustmentAllowed(S({ voucherFeatureEnabled: false })), false);
    assert.equal(voucherManualAdjustmentAllowed(S({ voucherManualAdjustmentEnabled: false })), false);
  });

  it("注文 ID は gid でも数字でも同じ注文とみなす", () => {
    assert.equal(normalizeOrderKey("gid://shopify/Order/123"), "123");
    assert.equal(normalizeOrderKey("123"), "123");
  });
});

describe("保存した設定の読み方", () => {
  it("配線前に保存した設定（版なし）は、メモから読むを ON とみなす（今までの動きのまま）", () => {
    const r = resolveVoucherSettings({ voucherNoteParseEnabled: false }, DEFAULT_VOUCHER_SETTINGS);
    assert.equal(r.voucherNoteParseEnabled, true);
    assert.equal(resolveVoucherSettings(null, DEFAULT_VOUCHER_SETTINGS).voucherNoteParseEnabled, true);
  });

  it("新しい画面で保存した設定は、そのまま効く", () => {
    const r = resolveVoucherSettings(
      { voucherNoteParseEnabled: false, settingsVersion: VOUCHER_SETTINGS_VERSION },
      DEFAULT_VOUCHER_SETTINGS,
    );
    assert.equal(r.voucherNoteParseEnabled, false);
  });

  it("読取用正規表現: 空は初めの式、不正とかっこ無しはエラー", () => {
    assert.deepEqual(compileVoucherNoteRegex(""), { regex: null, error: null });
    assert.ok(compileVoucherNoteRegex("額面([0-9]+)").regex);
    assert.ok(compileVoucherNoteRegex("額面[").error);
    assert.ok(compileVoucherNoteRegex("額面[0-9]+").error);
  });
});
