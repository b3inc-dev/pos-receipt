import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addressLines,
  domesticPhone,
  LAYOUT_ORDER_QUERY,
  japanesePrefecture,
  orderData,
  orderLevelDiscount,
  receiptTemplateData,
  sampleSettlementData,
  salesTemplateData,
  settlementTemplateData,
  staffNames,
} from "./receiptLayoutAdapters";
import {
  CIARA_SETTLEMENT_CALC,
  DEFAULT_SETTLEMENT_CALC,
  normalizeSalesData,
  normalizeSettlementCalc,
  orderSettlementPayments,
  settlementCashDeposit,
  type SettlementSectionInput,
} from "./receiptLayoutSettlementCalc";
import { layoutOrderHtml } from "./receiptLayoutOrderPrint.server";
import { normalizePrintEnabled, PRINT_CSP, renderLayoutForPrint, withPrintCsp } from "./receiptLayoutPrint.server";
import { ciaraReceiptLayout, ciaraSalesLayout, ciaraSettlementLayout, defaultLayout } from "./receiptLayoutPresets";

const m = (amount: number) => ({ shopMoney: { amount: String(amount), currencyCode: "JPY" } });

const ORDER = {
  name: "#1042",
  createdAt: "2026-11-20T11:58:00Z",
  note: "メモ",
  customAttributes: [{ key: "販売担当", value: "山田" }],
  subtotalPriceSet: m(4950),
  totalPriceSet: m(4950),
  totalDiscountsSet: m(440),
  totalShippingPriceSet: m(0),
  taxLines: [{ title: "消費税", rate: 0.1, priceSet: m(450) }],
  shippingLine: { title: "宅配" },
  shippingAddress: {
    zip: "530-0001",
    province: "Osaka",
    provinceCode: "JP-27",
    city: "大阪市北区",
    address1: "梅田1-2-3",
    address2: "梅田ハイツ 101",
    company: "",
    name: "山田 花子",
    phone: "+81 90-1234-5678",
    countryCodeV2: "JP",
  },
  retailLocation: {
    id: "gid://shopify/Location/1",
    name: "渋谷店",
    address: { zip: "150-0001", province: "Tokyo", provinceCode: "JP-13", city: "渋谷区", address1: "神宮前1-2-3", address2: "2F", phone: "+81 3-1234-5678", countryCode: "JP" },
  },
  lineItems: {
    nodes: [
      {
        title: "シート",
        name: "シート - Blue",
        variantTitle: "Blue",
        quantity: 1,
        sku: "S1",
        originalUnitPriceSet: m(990),
        discountedUnitPriceSet: m(990),
        variant: { compareAtPrice: null },
        customAttributes: [{ key: "スタッフ", value: "佐藤" }],
        staffMember: { name: "POS 担当" },
        discountAllocations: [],
      },
      {
        title: "ケース",
        name: "ケース",
        variantTitle: "Default Title",
        quantity: 2,
        sku: "C1",
        originalUnitPriceSet: m(2200),
        discountedUnitPriceSet: m(1980),
        variant: { compareAtPrice: "2750.0" },
        customAttributes: [{ key: "スタッフ", value: "佐藤" }, { key: "担当スタッフ", value: "鈴木" }],
        staffMember: null,
        discountAllocations: [{ allocatedAmountSet: m(440), discountApplication: { __typename: "ManualDiscountApplication", title: "セット割" } }],
      },
    ],
    pageInfo: { hasNextPage: false },
  },
  transactions: [
    { kind: "SALE", status: "SUCCESS", gateway: "cash", formattedGateway: "現金", amountSet: m(5000) },
    { kind: "CHANGE", status: "SUCCESS", gateway: "cash", formattedGateway: "現金", amountSet: m(-50) },
    { kind: "SALE", status: "FAILURE", gateway: "card", formattedGateway: "カード", amountSet: m(4950) },
  ],
};

describe("住所・電話の整え方（Ciara の header.liquid と同じ）", () => {
  it("県名を日本語にする", () => {
    assert.equal(japanesePrefecture("JP-13", "Tokyo"), "東京都");
    assert.equal(japanesePrefecture("", "Tōkyō"), "東京都");
    assert.equal(japanesePrefecture("", "Hokkaidō"), "北海道");
    assert.equal(japanesePrefecture("JP-27"), "大阪府");
    assert.equal(japanesePrefecture("", "大阪府"), "大阪府");
    assert.equal(japanesePrefecture("", "Hyogo-ken"), "兵庫県");
    assert.equal(japanesePrefecture("CA", "California"), "California");
  });
  it("+81 を 0 にし、空白を詰める", () => {
    assert.equal(domesticPhone("+81 3-1234-5678"), "03-1234-5678");
    assert.equal(domesticPhone("+8190 1234 5678"), "09012345678");
    assert.equal(domesticPhone("03-1234-5678"), "03-1234-5678");
    assert.equal(domesticPhone(null), "");
  });
  it("日本の住所は「県＋市区町村＋住所1」「住所2」", () => {
    assert.deepEqual(addressLines(ORDER.retailLocation.address), ["東京都渋谷区神宮前1-2-3", "2F"]);
    assert.deepEqual(addressLines({ address1: "1 Main St", city: "Austin", province: "TX", countryCode: "US" }), ["1 Main St", "Austin TX"]);
  });
});

describe("注文の読み方", () => {
  it("明細の staffMember を読まない（read_users の無い店で取得ごと失敗し、前の印字に戻るため）", () => {
    assert.equal(/staffMember/.test(LAYOUT_ORDER_QUERY), false);
  });
});

describe("販売レシートのデータ", () => {
  const data = orderData(ORDER, { timezone: "Asia/Tokyo" });
  it("明細の割引・通常価格・バリエーション", () => {
    assert.equal(data.line_items[0].variant_title, "Blue");
    assert.equal(data.line_items[1].variant_title, "");
    assert.equal(data.line_items[1].discount, 440);
    assert.equal(data.line_items[1].line_total, 3960);
    assert.equal(data.line_items[1].discount_label, "セット割");
    assert.equal(data.line_items[1].compare_at_price, 2750);
    assert.equal(data.line_items[0].compare_at_price, 0);
  });
  it("支払は成功した SALE だけ、お釣りは CHANGE から", () => {
    assert.deepEqual(data.payments, [{ label: "現金", amount: 5000 }]);
    assert.equal(data.change, 50);
  });
  it("日付は店のタイムゾーン、配送先があれば配送の注文", () => {
    assert.equal(data.created_at_label, "2026年11月20日 20:58");
    assert.equal(data.created_date, "2026-11-20");
    assert.equal(data.is_shipping_order, true);
    assert.deepEqual(data.shipping_address?.lines, ["大阪府大阪市北区梅田1-2-3", "梅田ハイツ 101"]);
    assert.equal(data.shipping_address?.phone, "090-1234-5678");
    assert.equal(orderData({ ...ORDER, shippingLine: null }, { timezone: "Asia/Tokyo" }).is_shipping_order, false);
  });
  it("小計の後の割引は 小計＋送料＋（税抜きなら）税−合計。明細の割引は入れない", () => {
    assert.equal(data.discounts, 0);
    assert.equal(orderLevelDiscount({ ...ORDER, subtotalPriceSet: m(5000), totalPriceSet: m(4500) }), 500);
    assert.equal(orderLevelDiscount({ ...ORDER, taxesIncluded: false, subtotalPriceSet: m(1000), totalPriceSet: m(1000) }), 450);
    assert.equal(orderLevelDiscount({ ...ORDER, totalShippingPriceSet: m(500), totalPriceSet: m(5450) }), 0);
  });
  it("Shopify がエラーを返したら（例外）今までの印字に戻す", async () => {
    const admin = { graphql: async () => { throw new Error("ACCESS_DENIED"); } };
    const r = await layoutOrderHtml(admin, "shop", "gid://shopify/Order/1", ciaraSalesLayout(), { kind: "sales", paperWidthMm: 80 });
    assert.deepEqual(r, { status: "fallback" });
  });
  it("税の内訳", () => {
    assert.deepEqual(data.tax_lines, [{ title: "消費税", rate_label: "10%", amount: 450 }]);
  });
  it("スタッフ名はプロパティから、同じ名前は 1 回、無ければ POS の担当", () => {
    assert.equal(staffNames(ORDER.lineItems.nodes, ["スタッフ", "担当スタッフ"]), "佐藤 / 鈴木");
    assert.equal(staffNames(ORDER.lineItems.nodes, ["なし"]), "POS 担当");
  });
  it("ギフトレシートに金額・メモ・属性・プロパティを渡さない", () => {
    const gift = salesTemplateData({ shop: { name: "店" }, order: ORDER }, "gift", { timezone: "Asia/Tokyo", printedAt: "2026-11-20T12:00:00Z" });
    assert.equal(gift.kind, "gift");
    if (gift.kind !== "gift") return;
    assert.equal(gift.order.total, 0);
    assert.deepEqual(gift.order.payments, []);
    assert.equal(gift.order.note, "");
    assert.deepEqual(gift.order.attributes, []);
    assert.ok(gift.order.line_items.every((li) => li.unit_price === 0 && li.properties.length === 0));
    const html = JSON.stringify(gift);
    assert.ok(!html.includes("4950") && !html.includes("メモ"));
  });
  it("Ciara 風の販売レシートが本物の注文の形で作れる", () => {
    const d = salesTemplateData({ shop: { name: "Ciara" }, order: ORDER }, "sales", { timezone: "Asia/Tokyo", printedAt: "2026-11-20T12:00:00Z", staffPropertyKeys: ["スタッフ"] });
    const html = renderLayoutForPrint(ciaraSalesLayout(), d, 80);
    assert.ok(html);
    assert.ok(html!.includes("ケース"));
    assert.ok(html!.includes("¥3,960"));
    assert.ok(html!.includes("スタッフ：佐藤"));
    assert.ok(html!.includes("東京都渋谷区神宮前1-2-3"));
    assert.ok(html!.includes("大阪府大阪市北区梅田1-2-3"));
    assert.ok(html!.includes("発送予定日"));
  });
});

const SECTIONS: SettlementSectionInput[] = [
  { label: "wespoアプリポイント", net: 1000, txCount: 1, refund: 300, refundCount: 1 },
  { label: "電子マネー(QR)", net: 2000, txCount: 2, refund: 0, refundCount: 0 },
  { label: "クレジットカード", net: 5000, txCount: 3, refund: 0, refundCount: 0 },
  { label: "現金", net: 8000, txCount: 5, refund: 500, refundCount: 1 },
  { label: "交通系ICカード決済", net: 700, txCount: 1, refund: 100, refundCount: 1 },
  { label: "その他", net: 10, txCount: 1, refund: 0, refundCount: 0 },
];

describe("精算: 支払方法の並びとまとめの行（Ciara の gift-receipt.liquid と同じ）", () => {
  it("初期値は並べ替えず、まとめの行も出さない", () => {
    const rows = orderSettlementPayments(SECTIONS, DEFAULT_SETTLEMENT_CALC);
    assert.deepEqual(rows.map((r) => r.label), SECTIONS.map((s) => s.label));
  });
  it("Ciara の並び。電子マネー(合計) はクレジットカードの後、無い支払方法は後ろ", () => {
    const rows = orderSettlementPayments(SECTIONS, CIARA_SETTLEMENT_CALC);
    assert.deepEqual(rows.map((r) => r.label), [
      "現金",
      "クレジットカード",
      "電子マネー(合計)",
      "電子マネー(QR)",
      "交通系ICカード決済",
      "wespoアプリポイント",
      "その他",
    ]);
    const sum = rows[2];
    assert.equal(sum.is_group, true);
    assert.deepEqual([sum.net, sum.count, sum.refund, sum.refund_count], [2700, 3, 100, 1]);
  });
  it("電子マネーが 1 種類だけならまとめの行を出さない", () => {
    const rows = orderSettlementPayments(SECTIONS.filter((s) => s.label !== "交通系ICカード決済"), CIARA_SETTLEMENT_CALC);
    assert.ok(!rows.some((r) => r.is_group));
  });
  it("大文字小文字の違いは同じ支払方法", () => {
    const rows = orderSettlementPayments([{ label: "WESPOアプリポイント", net: 1, txCount: 1, refund: 0, refundCount: 0 }, { label: "現金", net: 1, txCount: 1, refund: 0, refundCount: 0 }], CIARA_SETTLEMENT_CALC);
    assert.deepEqual(rows.map((r) => r.label), ["現金", "WESPOアプリポイント"]);
  });
  it("クレジットカードの行が無くても、並び順の位置に入れる", () => {
    const rows = orderSettlementPayments(SECTIONS.filter((s) => s.label !== "クレジットカード"), CIARA_SETTLEMENT_CALC);
    assert.deepEqual(rows.slice(0, 2).map((r) => r.label), ["現金", "電子マネー(合計)"]);
  });
});

describe("精算: 納金額", () => {
  const calc = { ...CIARA_SETTLEMENT_CALC, refundDeductLocations: ["Ciara梅田エスト店", "84233453814"] };
  it("ふつうの店は 現金の取引額 − 商品券釣り", () => {
    assert.equal(settlementCashDeposit(SECTIONS, { calc, locationId: "gid://shopify/Location/1", locationName: "渋谷店", voucherChange: 200 }), 7800);
  });
  it("特例の店は wespo などの返金も引く（名前でも ID でも）", () => {
    assert.equal(settlementCashDeposit(SECTIONS, { calc, locationId: "x", locationName: "ciara梅田エスト店", voucherChange: 0 }), 7700);
    assert.equal(settlementCashDeposit(SECTIONS, { calc, locationId: "gid://shopify/Location/84233453814", locationName: "", voucherChange: 0 }), 7700);
  });
  it("事後調整を足す", () => {
    assert.equal(settlementCashDeposit(SECTIONS, { calc, locationId: "", locationName: "", voucherChange: 0, manualDelta: 50 }), 8050);
  });
});

describe("精算レシートのデータとレイアウトの印字", () => {
  const base = {
    figures: { total: 16710, netSales: 15191, tax: 1519, discounts: 0, vipPointsUsed: 0, refundTotal: 900, orderCount: 13, refundCount: 3, itemCount: 20, voucherChangeAmount: 0 },
    sections: SECTIONS,
    title: "【精算レシート】",
    targetDate: "2026-11-22",
    locationId: "gid://shopify/Location/1",
    locationName: "渋谷店",
    location: { name: "渋谷店", zip: "", address_lines: [], phone: "" },
    shopName: "Ciara",
    currency: "JPY",
    issuedAt: "2026-11-22T12:05:00Z",
    printedAt: "2026-11-23T01:00:00Z",
    timezone: "Asia/Tokyo",
    calc: CIARA_SETTLEMENT_CALC,
  };
  it("合計額（返品含む）・発行の時・点検の表題", () => {
    const d = settlementTemplateData({ ...base, isInspection: true, title: "【点検レシート】" });
    assert.equal(d.kind, "settlement");
    if (d.kind !== "settlement") return;
    assert.equal(d.settlement.total_including_returns, 17610);
    assert.equal(d.settlement.kind_label, "点検");
    assert.equal(d.settlement.as_of, "2026年11月22日 21:05");
    assert.equal(d.settlement.cash_deposit, 8000);
  });
  it("Ciara 風の精算レシート: 電子マネー(合計)・納金額が出る", () => {
    const html = renderLayoutForPrint(ciaraSettlementLayout(), settlementTemplateData({ ...base, isInspection: false }), 80);
    assert.ok(html);
    assert.ok(html!.includes("電子マネー(合計)"));
    assert.ok(html!.includes("納金額"));
    assert.ok(html!.includes("¥8,000"));
    assert.ok(html!.indexOf("現金") < html!.indexOf("クレジットカード"));
  });
  it("管理画面の見本にも店の設定が入る", () => {
    const d = sampleSettlementData(CIARA_SETTLEMENT_CALC);
    if (d.kind !== "settlement") throw new Error("kind");
    assert.equal(d.settlement.payments[0].label, "現金");
    assert.ok(d.settlement.payments.some((p) => p.is_group));
  });
});

describe("領収書のデータ", () => {
  it("発行日は店のタイムゾーン、番号は注文番号", () => {
    const d = receiptTemplateData({
      shop: { name: "Ciara" },
      order: { taxLines: ORDER.taxLines, transactions: ORDER.transactions, retailLocation: ORDER.retailLocation },
      issue: { recipientName: "山田 太郎", proviso: "お品代", amount: 4950, currency: "JPY", orderName: "#1042", createdAt: new Date("2026-11-21T16:00:00Z") },
      timezone: "Asia/Tokyo",
      printedAt: "2026-11-21T16:00:00Z",
    });
    if (d.kind !== "receipt") throw new Error("kind");
    assert.equal(d.receipt.issue_date, "2026年11月22日");
    assert.equal(d.receipt.number, "#1042");
    assert.equal(d.location.phone, "03-1234-5678");
    const html = renderLayoutForPrint(ciaraReceiptLayout(), d, 58);
    assert.ok(html && html.includes("山田 太郎") && html.includes("¥4,950"));
  });
});

describe("印字の HTML", () => {
  it("スクリプトを止める CSP を <head> の先頭に入れる", () => {
    const html = withPrintCsp('<!DOCTYPE html><html><head lang="ja"><script>x()</script></head><body></body></html>');
    assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<script>"));
    assert.ok(PRINT_CSP.includes("script-src 'none'"));
    assert.ok(withPrintCsp("<p>a</p>").includes("Content-Security-Policy"));
  });
  it("レイアウトの印字は CSP 付き、用紙の幅は出力機器の設定", () => {
    const d = sampleSettlementData(DEFAULT_SETTLEMENT_CALC);
    const html58 = renderLayoutForPrint(defaultLayout("settlement"), d, 58)!;
    assert.ok(html58.includes("Content-Security-Policy"));
    assert.ok(html58.includes("384px") || html58.includes("58mm"));
  });
  it("テンプレートの誤りは null（呼ぶ側は今までの印字）", () => {
    const bad = { ...defaultLayout("sales"), mode: "code" as const, code: "{% if %}" };
    assert.equal(renderLayoutForPrint(bad, sampleSettlementData(DEFAULT_SETTLEMENT_CALC), 80), null);
  });
  it("「印字に使う」は既定で全部オフ", () => {
    assert.deepEqual(normalizePrintEnabled(null), { settlement: false, sales: false, gift: false, receipt: false });
    assert.equal(normalizePrintEnabled({ sales: true, gift: "yes" }).gift, false);
  });
});

describe("設定の読み込み", () => {
  it("壊れた値は初期値、空の行・重複は落とす", () => {
    assert.deepEqual(normalizeSettlementCalc(null), DEFAULT_SETTLEMENT_CALC);
    const c = normalizeSettlementCalc({ paymentOrder: ["現金", "", "現金", " カード "], groups: [{ label: "", members: ["a"] }, { label: "合計", members: ["a"], minActive: 0 }] });
    assert.deepEqual(c.paymentOrder, ["現金", "カード"]);
    assert.equal(c.groups.length, 1);
    assert.equal(c.groups[0].minActive, 1);
    assert.deepEqual(normalizeSalesData(undefined).staffPropertyKeys, ["スタッフ", "担当スタッフ", "販売スタッフ", "staff"]);
    assert.deepEqual(normalizeSalesData({ staffPropertyKeys: [] }).staffPropertyKeys, []);
  });
});
