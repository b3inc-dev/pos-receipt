/**
 * POS の注文一覧（領収書・販売レシート・返金/商品券）の見た目を、POS 純正の「すべての注文」に合わせた。
 * - 行: 「#1017 • 顧客名」＋右に金額 / 「今日 18:14」「11月20日 19:04」/ バッジ
 * - 日付は店のタイムゾーン（日本の店は日本時間）の暦日をサーバーが返し、それで「今日」を判定する
 * - s-text は POS にある属性（type・color・tone）だけを使う（fontWeight・size・fontSize は POS に無く、効かない）
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatOrderDayLabel,
  formatOrderDateTimeLabel,
  formatOrderTitle,
} from "../../extensions/common/orderListLabels.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("注文一覧の日時の書き方（純正と同じ）", () => {
  it("今日は「今日 18:14」", () => {
    assert.equal(
      formatOrderDateTimeLabel({ localDate: "2026-11-23", transactionTime: "18:14" }, "2026-11-23"),
      "今日 18:14",
    );
  });
  it("今年の別の日は「11月20日 19:04」（0 を付けない）", () => {
    assert.equal(
      formatOrderDateTimeLabel({ localDate: "2026-01-05", transactionTime: "19:04" }, "2026-11-23"),
      "1月5日 19:04",
    );
  });
  it("去年より前は年を付ける", () => {
    assert.equal(
      formatOrderDateTimeLabel({ localDate: "2025-11-20", transactionTime: "09:30" }, "2026-11-23"),
      "2025年11月20日 9:30",
    );
  });
  it("日付が無いとき（古いサーバー）は時刻だけ", () => {
    assert.equal(formatOrderDateTimeLabel({ transactionTime: "18:14" }, "2026-11-23"), "18:14");
  });
  it("日付ボタンの見出し", () => {
    assert.equal(formatOrderDayLabel("2026-11-23", "2026-11-23"), "今日");
    assert.equal(formatOrderDayLabel("2026-11-20", "2026-11-23"), "11月20日");
    assert.equal(formatOrderDayLabel("bad", "2026-11-23"), "");
  });
});

describe("注文一覧の 1 行目", () => {
  it("顧客ありは「#1017 • 顧客名」", () => {
    assert.equal(formatOrderTitle({ orderName: "#1017", customerName: "合成会員Shop Point" }), "#1017 • 合成会員Shop Point");
  });
  it("顧客なしは番号だけ（「顧客なし」と書かない。純正と同じ）", () => {
    assert.equal(formatOrderTitle({ orderName: "#1018", customerName: "" }), "#1018");
  });
});

describe("バッジの言葉", () => {
  it("Shopify の返金は「返金済」（技術用語を出さない）", () => {
    for (const rel of [
      "extensions/pos-smart-grid/src/orderDisplayUtils.js",
      "extensions/pos-smart-grid/src/OrderDayListScreen.jsx",
    ]) {
      const utils = readFileSync(`${ROOT}/extensions/pos-smart-grid/src/orderDisplayUtils.js`, "utf8");
      assert.match(utils, /PARTIALLY_REFUNDED"\) return \{ key: "refund", label: "一部返金"/);
      assert.match(utils, /label: "返金済"/);
      const src = readFileSync(`${ROOT}/${rel}`, "utf8");
      assert.match(src, /refundBadge\(item\)/, rel);
    }
  });
});

describe("一覧の画面は POS にある属性だけを使う", () => {
  for (const rel of [
    "extensions/pos-smart-grid/src/OrderListRow.jsx",
    "extensions/pos-smart-grid/src/OrderDayListScreen.jsx",
  ]) {
    it(rel, () => {
      const src = readFileSync(`${ROOT}/${rel}`, "utf8");
      // s-button の種類は variant（kind は POS に無い）
      assert.doesNotMatch(src, /<s-button[^>]*\bkind=/);
      // s-text の太字・大きさは type（fontWeight・size・fontSize は POS に無い）
      assert.doesNotMatch(src, /<s-text[^>]*\b(fontWeight|fontSize|size)=/);
      // 行の間に線を引かない（純正は余白で区切る）。線は固定の上下の境目だけ
      if (rel.endsWith("OrderListRow.jsx")) assert.doesNotMatch(src, /<s-divider/);
      // s-box に border は無い（POS では効かない）
      assert.doesNotMatch(src, /<s-box[^>]*\bborder=/);
      // 角かっこの文字のバッジに戻さない
      assert.doesNotMatch(src, /［\$\{/);
    });
  }
});

describe("店の人に英語のエラーを出さない・名前の許可が無くても一覧を出す", () => {
  it("一覧の読み込み失敗は決まった日本語の文", () => {
    const src = readFileSync(`${ROOT}/extensions/pos-smart-grid/src/OrderDayListScreen.jsx`, "utf8");
    assert.doesNotMatch(src, /setListError\(toUserMessage/);
    assert.match(src, /注文を読み込めませんでした/);
  });
  it("注文検索は保護された顧客データで断られたら名前なしで読み直す", () => {
    const src = readFileSync(`${ROOT}/app/routes/api.orders.search.tsx`, "utf8");
    assert.match(src, /ORDERS_SEARCH_QUERY_NO_CUSTOMER/);
    assert.match(src, /graphqlWithCustomerFallback/);
    const detail = readFileSync(`${ROOT}/app/routes/api.orders.$orderId.tsx`, "utf8");
    assert.match(detail, /graphqlWithCustomerFallback\(admin, ORDER_DETAIL_QUERY, ORDER_DETAIL_QUERY_NO_CUSTOMER_PII/);
  });
});

describe("領収書の発行履歴も一覧と同じ作り", () => {
  it("HistoryView は OrderDayListScreen を使い、発行の記録を読む", () => {
    const src = readFileSync(`${ROOT}/extensions/pos-smart-grid/src/ReceiptModal.jsx`, "utf8");
    const hist = src.slice(src.indexOf("function HistoryView"));
    assert.match(hist, /<OrderDayListScreen/);
    assert.match(src, /fetchList=\{fetchReceiptHistoryPage\}/);
  });
  it("発行履歴の API は店のタイムゾーンで日を区切り、今の店だけを出す", () => {
    const src = readFileSync(`${ROOT}/app/routes/api.receipts.history.tsx`, "utf8");
    assert.match(src, /getDayRangeInUtc\(dateFrom, timezone\)/);
    assert.doesNotMatch(src, /T00:00:00\.000Z/);
    assert.match(src, /locationId = \{ in:/);
  });
});

it("タイルごとの絞り込み: 自分のタイルの絞り込みと「すべて」だけ（T 2026-11-23）", async () => {
  const { listSegmentsForTile } = await import("../../extensions/pos-smart-grid/src/orderDisplayUtils.js");
  assert.deepEqual(listSegmentsForTile("refunded").map((s) => s.value), ["refunded", "all"]);
  assert.deepEqual(listSegmentsForTile("voucher_change").map((s) => s.value), ["voucher_change", "all"]);
  assert.equal(listSegmentsForTile("all").length, 3);
});
