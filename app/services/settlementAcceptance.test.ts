/**
 * 精算の受け入れテスト（Issue #17「初回の受け入れ条件案」の精算まわり）。
 *
 * 合成データだけで、店舗・日の精算が事前に決めた期待値と一致するかを確かめる。
 * 実店舗・実注文の値は使わない。DB / Shopify には触れない（純関数だけを呼ぶ）。
 *
 * - 対象: aggregateGasStyleForOrders / totalFromPayBuckets / resolveRefundAggregationLocationGid
 * - PR #11 で直る（main ではまだ満たさない）ケースは `it.skip` にしてある。
 *   #11 が main に入ったら skip を外す。モジュールは動的 import なので、外すまで main でも読み込みエラーにならない。
 * - 再印刷・接続先・実紙面など、純関数で確かめられない条件は対象外（PR 本文に一覧）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateGasStyleForOrders,
  totalFromPayBuckets,
  type GasAggregateAttributionOpts,
  type GasStyleOrder,
} from "./settlementAggregatePure.server";
import {
  resolveRefundAggregationLocationGid,
  type RefundAggregationContext,
} from "./refundAggregationPure.server";

// ---------------------------------------------------------------------------
// 合成データの部品
// ---------------------------------------------------------------------------

/** PR #11 で入るモジュール。変数にしておき、main では skip のまま読み込まない */
const PR11_OVERLAY_MODULE = "./specialRefundOverlayPure.server";
const PR11_AGGREGATE_MODULE = "./settlementAggregatePure.server";
const PR11_IDEMPOTENCY_MODULE = "./specialRefundIdempotency.server";

const STORE_A = "gid://shopify/Location/100";
const STORE_B = "gid://shopify/Location/200";

/** JST の暦日 [00:00, 24:00) を UTC で判定する（精算の dayRange と同じ考え方） */
function jstDay(ymd: string): (iso?: string) => boolean {
  const start = new Date(`${ymd}T00:00:00+09:00`).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  return (iso?: string) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= start && t < end;
  };
}

const DAY_PREV = "2026-11-19";
const DAY = "2026-11-20";
const inPrev = jstDay(DAY_PREV);
const inDay = jstDay(DAY);
/** JST の昼ごろ（どちらの日か迷わない時刻） */
const AT_PREV = "2026-11-19T03:00:00Z";
const AT_DAY = "2026-11-20T03:00:00Z";
const AT_DAY_LATER = "2026-11-20T06:00:00Z";

function money(amount: number) {
  return { shopMoney: { amount: String(amount), currencyCode: "JPY" } };
}

type Tx = NonNullable<GasStyleOrder["transactions"]>[number];
type Refund = NonNullable<GasStyleOrder["refunds"]>[number];

function sale(id: string, gateway: string, amount: number, createdAt = AT_DAY, formattedGateway?: string): Tx {
  return { id, kind: "SALE", gateway, formattedGateway: formattedGateway ?? null, amountSet: money(amount), createdAt };
}

function refundTx(id: string, gateway: string, amount: number, createdAt = AT_DAY): Tx {
  return { id, kind: "REFUND", gateway, amountSet: money(amount), createdAt };
}

/** Shopify の refunds[] 1 件。transactions は refunds 配下の形（location 付き） */
function refund(opts: {
  createdAt: string;
  qty: number;
  txs: { id: string; gateway: string; amount: number; location?: string | null }[];
}): Refund {
  return {
    createdAt: opts.createdAt,
    refundLineItems: opts.qty > 0 ? [{ quantity: opts.qty }] : [],
    transactions: opts.txs.map((t) => ({
      id: t.id,
      kind: "REFUND",
      gateway: t.gateway,
      amountSet: money(t.amount),
      location: t.location ? { id: t.location } : null,
    })),
  };
}

function order(o: {
  id: string;
  total: number;
  tax?: number;
  qty?: number;
  note?: string | null;
  retail?: string;
  transactions: Tx[];
  refunds?: Refund[];
  discounts?: { amount: number; type: string; code?: string; title?: string }[];
}): GasStyleOrder {
  return {
    id: `gid://shopify/Order/${o.id}`,
    note: o.note ?? null,
    cancelledAt: null,
    totalPriceSet: money(o.total),
    totalTaxSet: { shopMoney: { amount: String(o.tax ?? 0) } },
    lineItems: {
      nodes: [
        {
          quantity: o.qty ?? 1,
          discountAllocations: (o.discounts ?? []).map((d) => ({
            allocatedAmountSet: money(d.amount),
            discountApplication: { __typename: d.type, code: d.code ?? null, title: d.title ?? null },
          })),
        },
      ],
    },
    transactions: o.transactions,
    refunds: o.refunds ?? [],
    retailLocation: { id: o.retail ?? STORE_A },
  };
}

function attribution(
  settlementLocationId: string,
  ctx: Partial<RefundAggregationContext> = {},
): GasAggregateAttributionOpts {
  return {
    settlementLocationId,
    locIdRaw: settlementLocationId.replace("gid://shopify/Location/", ""),
    attributionCtx: {
      mode: "order_transaction",
      nonPosRefundFallbackMode: "order_retail_location",
      nonPosRefundTargetLocationGid: null,
      ...ctx,
    },
  };
}

/** 手段別の「売上 − 返金」（精算の手段別差引） */
function netByMethod(pay: ReturnType<typeof aggregateGasStyleForOrders>["pay"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(pay)) out[k] = Math.round(v.sale - v.refund);
  return out;
}

// ---------------------------------------------------------------------------
// 1. 元売上・複数決済
// ---------------------------------------------------------------------------

describe("受け入れ #17-1 元売上・複数決済", () => {
  const orders = [
    order({ id: "1001", total: 1100, tax: 100, qty: 2, transactions: [sale("t1", "cash", 1100)] }),
    order({ id: "1002", total: 2200, tax: 200, transactions: [sale("t2", "credit_card", 2200)] }),
    // 分割払い: カード 1000 ＋ 現金 1000 預かり（会計 1500、お釣り 500）
    order({
      id: "1003",
      total: 1500,
      tax: 136,
      transactions: [sale("t3a", "credit_card", 1000), sale("t3b", "cash", 1000)],
    }),
  ];
  const r = aggregateGasStyleForOrders(orders, inDay, attribution(STORE_A));

  it("総額と手段別差引が期待値と一致する（現金はお釣りを除いた額）", () => {
    assert.deepEqual(netByMethod(r.pay), { 現金: 1600, クレジットカード: 3200 });
    assert.equal(totalFromPayBuckets(r.pay), 4800);
    assert.equal(r.refundsGross, 0);
  });

  it("件数・点数・取引回数", () => {
    assert.equal(r.saleOrderSet.size, 3);
    assert.equal(r.refundOrderSet.size, 0);
    assert.equal(r.itemCount, 4);
    assert.equal(r.pay["現金"].saleTx, 2);
    assert.equal(r.pay["クレジットカード"].saleTx, 2);
  });

  it("商品券を使っていない現金のお釣りは商品券の釣銭に数えない", () => {
    assert.equal(r.voucherChangeObserved, 0);
  });

  it("消費税は注文の税額の合計", () => {
    assert.equal(r.taxTotalShopify, 436);
  });
});

// ---------------------------------------------------------------------------
// 2. 部分数量返品（同じ日）
// ---------------------------------------------------------------------------

describe("受け入れ #17-1 部分数量返品", () => {
  // 3 点 × 1000（値引き 300 の後で 3000）。同じ日に 1 点を返品
  const o = order({
    id: "2001",
    total: 3000,
    tax: 273,
    qty: 3,
    discounts: [{ amount: 300, type: "ManualDiscountApplication", title: "スタッフ値引き" }],
    transactions: [sale("s1", "credit_card", 3000), refundTx("r1", "credit_card", 1000, AT_DAY_LATER)],
    refunds: [
      refund({
        createdAt: AT_DAY_LATER,
        qty: 1,
        txs: [{ id: "r1", gateway: "credit_card", amount: 1000, location: STORE_A }],
      }),
    ],
  });
  const r = aggregateGasStyleForOrders([o], inDay, attribution(STORE_A));

  it("返金は 1 回だけ数える（transactions と refunds 配下に同じ返金があっても）", () => {
    assert.equal(r.refundsGross, 1000);
    assert.equal(r.pay["クレジットカード"].refund, 1000);
    assert.equal(r.pay["クレジットカード"].refundTx, 1);
  });

  it("総額・点数は返品分を引く", () => {
    assert.equal(totalFromPayBuckets(r.pay), 2000);
    assert.equal(r.itemCount, 2);
    assert.ok(r.saleOrderSet.has(o.id));
    assert.ok(r.refundOrderSet.has(o.id));
  });

  it("割引・税は残った売上の割合で按分する（2/3）", () => {
    assert.equal(r.discountsTotal, 200);
    assert.equal(r.taxTotalShopify, 182);
  });
});

// ---------------------------------------------------------------------------
// 3. 複数回返金・別日
// ---------------------------------------------------------------------------

describe("受け入れ #17-1 複数回返金・別日の返金", () => {
  // 前日に現金 3000（3 点）。前日に 1 点、当日に 1 点を返品
  const o = order({
    id: "3001",
    total: 3000,
    qty: 3,
    transactions: [
      sale("s1", "cash", 3000, AT_PREV),
      refundTx("r1", "cash", 1000, AT_PREV),
      refundTx("r2", "cash", 1000, AT_DAY),
    ],
    refunds: [
      refund({ createdAt: AT_PREV, qty: 1, txs: [{ id: "r1", gateway: "cash", amount: 1000, location: STORE_A }] }),
      refund({ createdAt: AT_DAY, qty: 1, txs: [{ id: "r2", gateway: "cash", amount: 1000, location: STORE_A }] }),
    ],
  });
  const prev = aggregateGasStyleForOrders([o], inPrev, attribution(STORE_A));
  const day = aggregateGasStyleForOrders([o], inDay, attribution(STORE_A));

  it("前日: 売上 3000・返金 1000（前日の返金だけ）", () => {
    assert.deepEqual(netByMethod(prev.pay), { 現金: 2000 });
    assert.equal(prev.refundsGross, 1000);
    assert.equal(prev.itemCount, 2);
  });

  it("当日: 売上は数えず、当日の返金 1000 だけ", () => {
    assert.equal(day.pay["現金"].sale, 0);
    assert.equal(day.pay["現金"].saleTx, 0);
    assert.equal(day.refundsGross, 1000);
    assert.equal(totalFromPayBuckets(day.pay), -1000);
    assert.equal(day.saleOrderSet.size, 0);
    assert.ok(day.refundOrderSet.has(o.id));
    assert.equal(day.itemCount, -1);
  });

  it("2 日の合計 = 元売上 − 返金の累計（返金を 2 回数えない）", () => {
    assert.equal(totalFromPayBuckets(prev.pay) + totalFromPayBuckets(day.pay), 3000 - 2000);
    assert.equal(prev.refundsGross + day.refundsGross, 2000);
  });
});

// ---------------------------------------------------------------------------
// 4. 別店舗の返金
// ---------------------------------------------------------------------------

describe("受け入れ #17-1 別店舗の返金", () => {
  // A で前日に売ったカード 2000 を、当日 B で返金
  const o = order({
    id: "4001",
    total: 2000,
    retail: STORE_A,
    transactions: [sale("s1", "credit_card", 2000, AT_PREV), refundTx("r1", "credit_card", 2000, AT_DAY)],
    refunds: [
      refund({ createdAt: AT_DAY, qty: 1, txs: [{ id: "r1", gateway: "credit_card", amount: 2000, location: STORE_B }] }),
    ],
  });

  it("注文基準（既定）: 返金は販売店舗 A に載り、B には載らない", () => {
    const a = aggregateGasStyleForOrders([o], inDay, attribution(STORE_A));
    const b = aggregateGasStyleForOrders([o], inDay, attribution(STORE_B));
    assert.equal(a.refundsGross, 2000);
    assert.equal(b.refundsGross, 0);
  });

  it("返金基準: 返金は返金した店舗 B に載り、A には載らない", () => {
    const ctx = { mode: "refund_transaction_pos_location" as const };
    const a = aggregateGasStyleForOrders([o], inDay, attribution(STORE_A, ctx));
    const b = aggregateGasStyleForOrders([o], inDay, attribution(STORE_B, ctx));
    assert.equal(a.refundsGross, 0);
    assert.equal(b.refundsGross, 2000);
    assert.equal(b.pay["クレジットカード"].refund, 2000);
  });

  it("どちらの基準でも、返金はちょうど 1 店舗にだけ載る", () => {
    for (const mode of ["order_transaction", "refund_transaction_pos_location"] as const) {
      const sum =
        aggregateGasStyleForOrders([o], inDay, attribution(STORE_A, { mode })).refundsGross +
        aggregateGasStyleForOrders([o], inDay, attribution(STORE_B, { mode })).refundsGross;
      assert.equal(sum, 2000, mode);
    }
  });

  it.skip("[#11] 返金基準: B の注文取得に無い（A で売った）注文の B での返金を B の精算に足す", async () => {
    const mod = await import(PR11_AGGREGATE_MODULE);
    const merged = mod.mergeCrossLocationRefundOrders([], [o], inDay, STORE_B, "200", "refund_transaction_pos_location");
    const b = aggregateGasStyleForOrders(merged, inDay, attribution(STORE_B, { mode: "refund_transaction_pos_location" }));
    assert.equal(b.refundsGross, 2000);
    // 売上は B に移さない
    assert.equal(totalFromPayBuckets(b.pay), -2000);
  });

  it.skip("[#11] 返金基準: 同じ注文を同じ日に A と B で 1 回ずつ返金したら、それぞれの店に分ける", () => {
    const split = order({
      id: "4002",
      total: 3000,
      qty: 3,
      retail: STORE_A,
      transactions: [
        sale("s1", "cash", 3000, AT_PREV),
        refundTx("ra", "cash", 1000, AT_DAY),
        refundTx("rb", "cash", 1000, AT_DAY_LATER),
      ],
      refunds: [
        refund({ createdAt: AT_DAY, qty: 1, txs: [{ id: "ra", gateway: "cash", amount: 1000, location: STORE_A }] }),
        refund({ createdAt: AT_DAY_LATER, qty: 1, txs: [{ id: "rb", gateway: "cash", amount: 1000, location: STORE_B }] }),
      ],
    });
    const ctx = { mode: "refund_transaction_pos_location" as const };
    assert.equal(aggregateGasStyleForOrders([split], inDay, attribution(STORE_A, ctx)).refundsGross, 1000);
    assert.equal(aggregateGasStyleForOrders([split], inDay, attribution(STORE_B, ctx)).refundsGross, 1000);
  });
});

// ---------------------------------------------------------------------------
// 5. 割引と支払を二重に数えない
// ---------------------------------------------------------------------------

describe("受け入れ #17 割引と支払の二重計上なし", () => {
  // 定価 1000 − 値引き 200 − ポイント 100 = 現金 700
  const o = order({
    id: "5001",
    total: 700,
    discounts: [
      { amount: 200, type: "ManualDiscountApplication", title: "値引き" },
      { amount: 100, type: "ManualDiscountApplication", title: "Shop Point" },
    ],
    transactions: [sale("s1", "cash", 700)],
  });
  const r = aggregateGasStyleForOrders([o], inDay, attribution(STORE_A));

  it("支払の合計は実際に払われた額（割引を支払から二重に引かない）", () => {
    assert.equal(totalFromPayBuckets(r.pay), 700);
  });

  it("値引きは割引に、ポイント利用はポイントに分けて 1 回ずつ", () => {
    assert.equal(r.discountsTotal, 200);
    assert.equal(r.vipPointsUsed, 100);
  });
});

// ---------------------------------------------------------------------------
// 6. 商品券（既決の紙・外部商品券の釣銭）
// ---------------------------------------------------------------------------

describe("受け入れ #17 商品券の釣銭", () => {
  // 会計 1500 を 商品券釣有り 1000 ＋ 現金 1000 預かり。現金のお釣り 500 を商品券の釣銭として観測
  const o = order({
    id: "6001",
    total: 1500,
    transactions: [sale("s1", "gift_card", 1000, AT_DAY, "商品券釣有り"), sale("s2", "cash", 1000)],
  });
  const r = aggregateGasStyleForOrders([o], inDay, attribution(STORE_A));

  it("現金は会計に必要な分だけ、商品券は額面どおり", () => {
    assert.deepEqual(netByMethod(r.pay), { 商品券釣有り: 1000, 現金: 500 });
    assert.equal(totalFromPayBuckets(r.pay), 1500);
  });

  it("お釣り 500 を商品券の釣銭として 1 回だけ数える", () => {
    assert.equal(r.voucherChangeObserved, 500);
  });
});

// ---------------------------------------------------------------------------
// 7. 未分類・返金帰属が決まらない場合は見える形で残す
// ---------------------------------------------------------------------------

describe("受け入れ #17 支払手段未分類・返金帰属未解決", () => {
  it("決済手段が分からない支払は「未分類」に入れ、金額を落とさない", () => {
    const o = order({ id: "7001", total: 500, transactions: [sale("s1", "", 500)] });
    const r = aggregateGasStyleForOrders([o], inDay, attribution(STORE_A));
    assert.equal(r.pay["未分類"].sale, 500);
    assert.equal(totalFromPayBuckets(r.pay), 500);
  });

  it("返金 TX が取れず refunds だけある返金は「未分類」の返金として残す", () => {
    const o = order({
      id: "7002",
      total: 1000,
      transactions: [sale("s1", "cash", 1000, AT_PREV)],
      refunds: [refund({ createdAt: AT_DAY, qty: 1, txs: [{ id: "r-only", gateway: "cash", amount: 1000, location: STORE_A }] })],
    });
    const r = aggregateGasStyleForOrders([o], inDay, attribution(STORE_A));
    assert.equal(r.pay["未分類"].refund, 1000);
    assert.equal(r.refundsGross, 1000);
  });

  it("POS 以外の返金で計上先が決まらない設定（除外・計上先なし）は、どの店にも載せない", () => {
    const o = order({
      id: "7003",
      total: 1000,
      transactions: [sale("s1", "cash", 1000, AT_PREV), refundTx("r1", "cash", 1000, AT_DAY)],
      refunds: [refund({ createdAt: AT_DAY, qty: 1, txs: [{ id: "r1", gateway: "cash", amount: 1000, location: null }] })],
    });
    const ctx: RefundAggregationContext = {
      mode: "order_transaction",
      nonPosRefundFallbackMode: "exclude",
      nonPosRefundTargetLocationGid: null,
    };
    assert.equal(resolveRefundAggregationLocationGid(o, ctx, inDay), null);
    for (const store of [STORE_A, STORE_B]) {
      assert.equal(aggregateGasStyleForOrders([o], inDay, attribution(store, ctx)).refundsGross, 0, store);
    }
  });

  it("POS 以外の返金の計上先を 1 店に決めてあれば、その店にだけ載る", () => {
    const o = order({
      id: "7004",
      total: 1000,
      transactions: [sale("s1", "cash", 1000, AT_PREV), refundTx("r1", "cash", 1000, AT_DAY)],
      refunds: [refund({ createdAt: AT_DAY, qty: 1, txs: [{ id: "r1", gateway: "cash", amount: 1000, location: null }] })],
    });
    const ctx = { nonPosRefundTargetLocationGid: STORE_B };
    assert.equal(aggregateGasStyleForOrders([o], inDay, attribution(STORE_A, ctx)).refundsGross, 0);
    assert.equal(aggregateGasStyleForOrders([o], inDay, attribution(STORE_B, ctx)).refundsGross, 1000);
  });
});

// ---------------------------------------------------------------------------
// 8. 特殊返金（例外返金・決済手段変更）— PR #11 で直る
// ---------------------------------------------------------------------------

type Section = { gateway: string; label: string; net: number; refund: number; txCount: number; refundCount: number };

/** カードで 3000 売り、Shopify でカードに 1000 返金済みの日 */
function cardRefundedSections(): Section[] {
  return [{ gateway: "credit_card", label: "クレジットカード", net: 3000, refund: 1000, txCount: 1, refundCount: 1 }];
}

describe("受け入れ #17-2 特殊返金（#11）", () => {
  it.skip("[#11] Shopify で返金済み（success）の例外返金は、返金総額も実返金も増やさず、カード→現金に振り替えるだけ", async () => {
    const { applySpecialRefundEventsToTotals } = await import(PR11_OVERLAY_MODULE);
    const sections = cardRefundedSections();
    const totals = { total: 2000, refundTotal: 1000 };
    applySpecialRefundEventsToTotals(sections, [
      {
        eventType: "cash_refund",
        amount: 1000,
        originalPaymentMethod: "credit_card",
        actualRefundMethod: "cash",
        adjustKind: null,
        shopifyRefundStatus: "success",
      },
    ], totals);
    assert.equal(totals.refundTotal, 1000);
    const card = sections.find((s) => s.gateway === "credit_card")!;
    const cash = sections.find((s) => s.gateway === "cash")!;
    assert.equal(card.refund, 0);
    assert.equal(cash.refund, 1000);
    assert.equal(sections.reduce((s, x) => s + x.refund, 0), 1000);
  });

  it.skip("[#11] 決済手段変更（success）は元手段→実手段の振替のみで、返金総額を増やさない", async () => {
    const { applySpecialRefundEventsToTotals } = await import(PR11_OVERLAY_MODULE);
    const sections = cardRefundedSections();
    const totals = { total: 2000, refundTotal: 1000 };
    applySpecialRefundEventsToTotals(sections, [
      {
        eventType: "payment_method_override",
        amount: 1000,
        originalPaymentMethod: "credit_card",
        actualRefundMethod: "cash",
        adjustKind: null,
        shopifyRefundStatus: "success",
      },
    ], totals);
    assert.equal(totals.refundTotal, 1000);
    assert.equal(sections.reduce((s, x) => s + x.refund, 0), 1000);
  });

  it.skip("[#11] Shopify 返金の結果が分からない（pending）特殊返金は数えず、精算の確定を止める", async () => {
    const { applySpecialRefundEventsToTotals, assertNoPendingSpecialRefunds } = await import(PR11_OVERLAY_MODULE);
    const sections = cardRefundedSections();
    const totals = { total: 2000, refundTotal: 1000 };
    const ev = {
      eventType: "cash_refund",
      amount: 1000,
      originalPaymentMethod: "credit_card",
      actualRefundMethod: "cash",
      adjustKind: null,
      shopifyRefundStatus: "pending",
      sourceOrderName: "#T-0001",
    };
    applySpecialRefundEventsToTotals(sections, [ev], totals);
    assert.equal(totals.refundTotal, 1000);
    assert.throws(() => assertNoPendingSpecialRefunds([ev]), /確定していません/);
  });

  it.skip("[#11] Shopify で返金していない外部支払いの記録は、実返金とは別に上乗せとして数える", async () => {
    const { applySpecialRefundEventsToTotals } = await import(PR11_OVERLAY_MODULE);
    const sections = cardRefundedSections();
    const totals = { total: 2000, refundTotal: 1000 };
    applySpecialRefundEventsToTotals(sections, [
      {
        eventType: "cash_refund",
        amount: 500,
        originalPaymentMethod: "credit_card",
        actualRefundMethod: "cash",
        adjustKind: null,
        shopifyRefundStatus: "none",
      },
    ], totals);
    assert.equal(totals.refundTotal, 1500);
    assert.equal(sections.find((s) => s.gateway === "credit_card")!.refund, 1000);
    assert.equal(sections.find((s) => s.gateway === "cash")!.refund, 500);
  });

  it.skip("[#11] 同じ冪等キーの再送は同じ登録になり、別内容でのキー再利用は一致しない", async () => {
    const mod = await import(PR11_IDEMPOTENCY_MODULE);
    const key = "abcdefghijklmnop1234";
    assert.equal(mod.specialRefundEventIdFromIdempotencyKey(key), mod.specialRefundEventIdFromIdempotencyKey(key));
    const base = {
      shopId: "shop",
      sourceOrderId: "gid://shopify/Order/9001",
      locationId: STORE_A,
      eventType: "cash_refund",
      amount: 1000,
      currency: "JPY",
      originalPaymentMethod: "credit_card",
      actualRefundMethod: "cash",
      adjustKind: null,
      note: null,
    };
    assert.equal(mod.matchesSpecialRefundIdempotencyPayload(base, { ...base }), true);
    assert.equal(mod.matchesSpecialRefundIdempotencyPayload(base, { ...base, amount: 2000 }), false);
  });
});
